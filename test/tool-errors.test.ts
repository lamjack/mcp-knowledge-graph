// 工具錯誤通道測試（stdio 整合）：
//   1. 缺必填參數 / 實體不存在等「工具層錯誤」必須以 isError:true 的正常結果回傳，
//      而不是 JSON-RPC 協議級錯誤（-32603）。生產實測（2026-08-11/12 IDE log）：
//      協議級錯誤會被客戶端誤判為連線故障（"MCP operation failed on cached service,
//      retrying with fresh connection"），每次失敗都殺掉並重啟健康的 server 行程，
//      對模型呈現為 "Failed to connect to MCP server" 與整段斷連窗口。
//   2. 合法的 remove_facts / replace_fact 呼叫成功，且同一 session 後續呼叫正常
//      （server 不退出）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INIT, INITIALIZED, call, driveServer, tmpRoot as makeTmpRoot } from './helpers.js';

function tmpRoot(): string {
  return makeTmpRoot('kg-err-');
}

// 斷言某 id 的回應是「isError 結構化結果」而非協議級錯誤，且訊息可指導修正。
function assertIsErrorResult(resp: any, match: RegExp, label: string): void {
  assert.equal(
    resp?.error,
    undefined,
    `${label}: 不得為協議級 JSON-RPC 錯誤（會觸發客戶端重連風暴）: ${JSON.stringify(resp?.error)}`,
  );
  assert.ok(resp?.result, `${label}: 預期正常的 tools/call 結果`);
  assert.equal(resp.result.isError, true, `${label}: 工具錯誤須以 isError:true 標記`);
  const text: string = resp.result.content[0].text;
  assert.match(text, match, `${label}: 錯誤訊息須指出問題所在`);
}

test('remove_facts 缺 deletions：回傳 isError 結構化結果（非協議級 -32603），同 session 後續呼叫正常', async () => {
  const root = tmpRoot();
  const out = await driveServer(
    ['--workspace-only'],
    [
      INIT,
      INITIALIZED,
      call(2, 'aim_memory_remove_facts', { projectRoot: root }),
      call(3, 'aim_memory_get', { projectRoot: root, names: ['anything'] }),
    ],
    3,
  );
  const bad = out.find(m => m.id === 2);
  assertIsErrorResult(
    bad,
    /Missing required argument\(s\).*deletions/,
    'remove_facts 缺 deletions',
  );
  const alive = out.find(m => m.id === 3);
  assert.ok(alive?.result && !alive.error, '錯誤之後同一 server 行程必須繼續正常服務（無需重連）');
});

test('replace_fact 缺 newText：回傳 isError 結構化結果（非協議級 -32603）', async () => {
  const root = tmpRoot();
  const out = await driveServer(
    ['--workspace-only'],
    [
      INIT,
      INITIALIZED,
      call(2, 'aim_memory_replace_fact', { projectRoot: root, entityName: 'E', matchPrefix: 'x' }),
    ],
    2,
  );
  const bad = out.find(m => m.id === 2);
  assertIsErrorResult(bad, /Missing required argument\(s\).*newText/, 'replace_fact 缺 newText');
});

test('未知工具名稱：回傳可辨識的 "Unknown tool" isError 結果，而非隱晦的 undefined 存取錯誤', async () => {
  const root = tmpRoot();
  const out = await driveServer(
    ['--workspace-only'],
    [
      INIT,
      INITIALIZED,
      call(2, 'aim_memory_does_not_exist', { projectRoot: root }),
      // 未知工具不得殺掉 server：後續合法呼叫仍須正常。
      call(3, 'aim_memory_list_stores', { projectRoot: root }),
    ],
    3,
  );
  const bad = out.find(m => m.id === 2);
  assertIsErrorResult(bad, /Unknown tool: aim_memory_does_not_exist/, '未知工具名稱');
  const alive = out.find(m => m.id === 3);
  assert.ok(alive?.result && !alive.error, '未知工具之後同一 server 行程必須繼續正常服務');
});

test('replace_fact 目標實體不存在：儲存層錯誤同樣回傳 isError 結構化結果', async () => {
  const root = tmpRoot();
  const out = await driveServer(
    ['--workspace-only'],
    [
      INIT,
      INITIALIZED,
      call(2, 'aim_memory_replace_fact', {
        projectRoot: root,
        entityName: 'Ghost',
        matchPrefix: 'x',
        newText: 'y',
      }),
    ],
    2,
  );
  const bad = out.find(m => m.id === 2);
  assertIsErrorResult(bad, /Entity with name Ghost not found/, 'replace_fact 實體不存在');
});

test('合法 remove_facts / replace_fact 成功且 server 不退出（原始症狀回歸守衛）', async () => {
  const root = tmpRoot();
  // session 1：寫入種子資料
  const seedOut = await driveServer(
    ['--workspace-only'],
    [
      INIT,
      INITIALIZED,
      call(2, 'aim_memory_store', {
        projectRoot: root,
        entities: [{ name: 'E0', entityType: 't', observations: ['old fact', 'keep me'] }],
      }),
    ],
    2,
  );
  assert.ok(seedOut.find(m => m.id === 2)?.result, 'precondition: store must succeed');

  // session 2：先删后替换。同一檔案的寫入由 write chain 序列化，replace 的回應
  // 保證在 remove 之後發出；兩者都回應即證明同一行程存活且兩個操作都成功。
  const out = await driveServer(
    ['--workspace-only'],
    [
      INIT,
      INITIALIZED,
      call(2, 'aim_memory_remove_facts', {
        projectRoot: root,
        deletions: [{ entityName: 'E0', observations: ['old fact'] }],
      }),
      call(3, 'aim_memory_replace_fact', {
        projectRoot: root,
        entityName: 'E0',
        matchPrefix: 'keep',
        newText: 'keep me v2',
      }),
    ],
    3,
  );
  const removed = out.find(m => m.id === 2);
  assert.ok(removed?.result && !removed.error, 'remove_facts 必須成功');
  const replaced = out.find(m => m.id === 3);
  assert.ok(replaced?.result && !replaced.error, 'replace_fact 必須成功');
  assert.match(replaced.result.content[0].text, /"matched": 1/);

  // session 3：讀回驗證最終狀態（讀取不走 write chain，須分開 session 避免與寫入競態）。
  const readOut = await driveServer(
    ['--workspace-only'],
    [INIT, INITIALIZED, call(2, 'aim_memory_get', { projectRoot: root, names: ['E0'] })],
    2,
  );
  const got = readOut.find(m => m.id === 2);
  assert.ok(got?.result && !got.error, '後續 get 必須成功（server 未退出）');
  const text: string = got.result.content[0].text;
  assert.match(text, /keep me v2/);
  assert.doesNotMatch(text, /old fact/);
});
