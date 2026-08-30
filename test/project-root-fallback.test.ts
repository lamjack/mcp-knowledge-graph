// 缺 projectRoot 時的後備解析。
//
// 成因：workspace-only 要求每次呼叫都帶 projectRoot，而實測 55 筆拒絕中有 10 筆（18%）
// 就是缺它，其中 6 筆是 `store | entities`——呼叫端知道要寫什麼，只是不知道路徑。
//
// 兩層解法，關鍵差別在「是不是猜的」：
//   ① cwd 偵測結果只放進錯誤訊息當候選，**永不據以寫入**。因為 workspace-only 的前提
//      就是單一實例服務所有 workspace，而行程的 cwd 是它啟動時的目錄，不是當次呼叫
//      所屬的 workspace——自動採用會「很有信心地寫進錯的專案」，那正是 2026-08-23
//      已發生過的跨 workspace 污染事故。實測兩個並存行程的 cwd 一個是 `/`、
//      一個剛好是本 workspace，足證此值不可信。
//   ② MCP roots 是協議層正解：客戶端宣告 roots 且**只回一個** root 時，那不是猜測而是
//      客戶端明確告知的工作區，可以直接採用；回多個則語義不明，只列為候選。
//
// 兩者都會在回應前置抬頭告知發生了什麼——與 alias 同一原則：善意的後備不能是隱形的。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import { formatRootCandidates } from '../server.js';

const SERVER = path.resolve(import.meta.dirname, '../index.js');

function tmpRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'kg-rootfb-'));
}

// 會回應 server→client 請求的測試驅動。helpers 的 driveServer 只單向送訊息，
// 而驗證 roots 必須真的回答伺服器發來的 roots/list。
function driveWithRoots(
  args: string[],
  clientCapabilities: object,
  roots: string[] | null,
  calls: { id: number; name: string; args: object }[],
  timeoutMs = 6000,
): Promise<{ messages: any[]; sawRootsRequest: boolean }> {
  return new Promise(resolve => {
    const child = spawn('node', [SERVER, ...args], { stdio: ['pipe', 'pipe', 'ignore'] });
    const messages: any[] = [];
    let sawRootsRequest = false;
    let buf = '';
    let done = false;
    const lastId = calls[calls.length - 1]!.id;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve({ messages, sawRootsRequest });
    };
    const timer = setTimeout(finish, timeoutMs);
    const send = (o: object) => child.stdin.write(JSON.stringify(o) + '\n');

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const m = JSON.parse(line);
        // 伺服器發來的請求（roots/list）：依測試設定回應或回錯誤。
        if (m.method === 'roots/list') {
          sawRootsRequest = true;
          if (roots === null)
            send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not supported' } });
          else
            send({
              jsonrpc: '2.0',
              id: m.id,
              result: {
                roots: roots.map(r => ({ uri: pathToFileURL(r).href, name: path.basename(r) })),
              },
            });
          continue;
        }
        messages.push(m);
        if (m.id === lastId) finish();
      }
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: clientCapabilities,
        clientInfo: { name: 'roots-test', version: '0' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    for (const c of calls)
      send({
        jsonrpc: '2.0',
        id: c.id,
        method: 'tools/call',
        params: { name: c.name, arguments: c.args },
      });
  });
}

test('formatRootCandidates：無候選回 undefined，有候選則產生可直接照抄的指引', () => {
  assert.equal(formatRootCandidates([]), undefined, '沒有候選時不得產生誤導性的空指引');
  const one = formatRootCandidates(['/Users/x/proj']);
  assert.match(one!, /\/Users\/x\/proj/);
  const two = formatRootCandidates(['/a/one', '/b/two']);
  assert.match(two!, /\/a\/one/);
  assert.match(two!, /\/b\/two/);
});

test('② 客戶端宣告 roots 且只回一個：直接採用（客戶端明確告知，非猜測）並前置抬頭', async () => {
  const root = tmpRoot();
  const { messages, sawRootsRequest } = await driveWithRoots(
    ['--workspace-only'],
    { roots: {} },
    [root],
    [
      {
        id: 2,
        name: 'aim_memory_store',
        args: { entities: [{ name: 'FromRoots', entityType: 'concept', observations: ['x'] }] },
      },
    ],
  );
  assert.ok(sawRootsRequest, '伺服器必須真的向客戶端查詢 roots');
  const resp = messages.find(m => m.id === 2);
  assert.ok(
    resp?.result && resp.result.isError !== true,
    `應採用該 root 並成功，實得: ${JSON.stringify(resp?.result)}`,
  );
  const text: string = resp.result.content[0].text;
  assert.match(text, /\[projectRoot\]/, '須告知 projectRoot 是後備解析來的');
  assert.match(text, /FromRoots/, '仍須回傳正確結果');
});

test('② 客戶端回多個 root：語義不明，不得挑一個猜——仍拒絕但把候選列進訊息', async () => {
  const a = tmpRoot();
  const b = tmpRoot();
  const { messages } = await driveWithRoots(
    ['--workspace-only'],
    { roots: {} },
    [a, b],
    [{ id: 2, name: 'aim_memory_store', args: { entities: [] } }],
  );
  const resp = messages.find(m => m.id === 2);
  assert.equal(resp.result.isError, true, '多個 root 時絕不可猜（猜錯＝寫進別的專案）');
  const text: string = resp.result.content[0].text;
  assert.match(text, /projectRoot is required/);
  assert.match(text, new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '訊息須列出候選 a');
  assert.match(text, new RegExp(b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '訊息須列出候選 b');
});

test('① 客戶端未宣告 roots：退回 cwd 偵測，結果只作為訊息中的候選（永不自動寫入）', async () => {
  const { messages, sawRootsRequest } = await driveWithRoots(['--workspace-only'], {}, null, [
    { id: 2, name: 'aim_memory_store', args: { entities: [] } },
  ]);
  assert.equal(sawRootsRequest, false, '客戶端未宣告 roots 時不得發出 roots/list（SDK 會拒絕）');
  const resp = messages.find(m => m.id === 2);
  assert.equal(resp.result.isError, true, 'cwd 偵測結果永不自動採用');
  const text: string = resp.result.content[0].text;
  assert.match(text, /projectRoot is required/);
  // 測試行程的 cwd 是本 repo（有 package.json 與 .aim），故偵測必有命中。
  assert.match(text, /knowledge-graph-mcp/, '須把偵測到的候選路徑放進訊息供呼叫端照抄');
  assert.match(text, /\[diagnostic\]/, '既有的診斷抬頭必須保留');
});

test('顯式給了 projectRoot 時不得觸發任何後備（也不得出現抬頭）', async () => {
  const root = tmpRoot();
  const { messages, sawRootsRequest } = await driveWithRoots(
    ['--workspace-only'],
    { roots: {} },
    [tmpRoot()],
    [
      {
        id: 2,
        name: 'aim_memory_store',
        args: {
          projectRoot: root,
          entities: [{ name: 'Explicit', entityType: 'concept', observations: [] }],
        },
      },
    ],
  );
  assert.equal(sawRootsRequest, false, '有 projectRoot 就不該多一次 roots 往返');
  const text: string = messages.find(m => m.id === 2).result.content[0].text;
  assert.doesNotMatch(text, /\[projectRoot\]/);
});
