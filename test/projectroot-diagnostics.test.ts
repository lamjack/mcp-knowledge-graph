// projectRoot 缺失的可診斷性（2026-08-23 間歇性誤報調查）。
//
// 症狀：客戶端間歇性收到 "Workspace-only mode: projectRoot is required"，同一 payload
// 隔幾分鐘重試即成功。錯誤是「乾淨缺鍵」（JSON 解析成功、arguments 裡就是沒有 projectRoot），
// 但原訊息不含任何「實際收到什麼」的資訊，因此無法分辨兩種完全不同的成因：
//   (a) 客戶端橋接層送出時就丟了鍵（arguments 只剩 entities/context…）；
//   (b) 呼叫端真的沒傳（模型漏參數）。
// 兩者的修法南轅北轍，卻共用同一句話。本檔把「收到的鍵清單 + payload 字節數」釘進
// 錯誤訊息與 stderr，讓一次呼叫即可分辨，並可與客戶端日誌對拍定位重啟窗口。
//
// 注意「診斷歸屬層」：只有 server 層看得到原始 arguments，storage 的 getMemoryFilePath
// 只收到解析後的 projectRoot，結構上不可能知道鍵清單。故訊息主文（單一真相）留在
// storage.ts，診斷抬頭由 server 層附加。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';

import { argsDiagnostic, macauIsoTimestamp } from '../server.js';
import { PROJECT_ROOT_REQUIRED_MESSAGE } from '../storage.js';
import { DIAGNOSTIC_SINK_MAX_BYTES } from '../diagnostics.js';
import { INIT, INITIALIZED, call, runServer, tmpRoot as makeTmpRoot } from './helpers.js';

function tmpRoot(): string {
  return makeTmpRoot('kg-diag-');
}

// --- argsDiagnostic（單元） -------------------------------------------------

test('argsDiagnostic：列出收到的鍵（原順序）與工具名', () => {
  const line = argsDiagnostic('aim_memory_store', { entities: [], context: 'work' });
  assert.match(line, /tool=aim_memory_store/);
  assert.match(line, /received keys: entities,context/);
});

test('argsDiagnostic：字節數為 UTF-8 位元組數，非字元數（CJK 每字 3 bytes）', () => {
  // {"a":"中"} = 8 個 ASCII 字元 + 1 個 CJK（3 bytes）= 11 bytes（手算，非以受測碼推導）。
  const line = argsDiagnostic('t', { a: '中' });
  assert.match(line, /arguments bytes=11\b/);
});

test('argsDiagnostic：空 arguments 明確標示 (none)，不留空白造成誤讀', () => {
  const line = argsDiagnostic('t', {});
  assert.match(line, /received keys: \(none\)/);
  assert.match(line, /arguments bytes=2\b/); // "{}"
});

test('argsDiagnostic：arguments 鍵不存在與 arguments:{} 必須可分辨', () => {
  // 兩者是不同的客戶端故障形態：整包沒送 vs 送了空物件。若共用 (none)，
  // 判讀表就無法把「橋接層整包丟失」與「呼叫端送了空物件」分開。
  const absent = argsDiagnostic('t', undefined);
  assert.match(absent, /received keys: \(arguments key absent\)/);
  assert.match(absent, /arguments bytes=0\b/);
  assert.notEqual(absent, argsDiagnostic('t', {}));
});

// --- macauIsoTimestamp（單元） ---------------------------------------------

test('macauIsoTimestamp：輸出帶顯式 +08:00 位移的 ISO 8601（Asia/Macau 固定 UTC+8）', () => {
  // UTC 04:03:11.234 → 澳門 12:03:11.234（手算）。
  const ts = macauIsoTimestamp(new Date(Date.UTC(2026, 7, 23, 4, 3, 11, 234)));
  assert.equal(ts, '2026-08-23T12:03:11.234+08:00');
});

// --- 錯誤訊息（stdio 整合） -------------------------------------------------

test('store 缺 projectRoot：錯誤訊息同時帶原句、收到的鍵清單與 payload 字節數', async () => {
  const { messages } = await runServer(
    ['--workspace-only'],
    [
      INIT,
      INITIALIZED,
      call(2, 'aim_memory_store', {
        entities: [{ name: 'E', entityType: 't', observations: ['中文觀察'] }],
        context: 'work',
      }),
    ],
    2,
  );
  const resp = messages.find(m => m.id === 2);
  assert.equal(resp?.error, undefined, '必須走 isError 通道，不得是協議級錯誤');
  assert.equal(resp.result.isError, true);
  const text: string = resp.result.content[0].text;

  assert.ok(text.startsWith(PROJECT_ROOT_REQUIRED_MESSAGE), '原有指引句必須保留在最前');
  assert.match(text, /tool=aim_memory_store/);
  assert.match(text, /received keys: entities,context/, '缺的是 projectRoot，收到的鍵要逐一列出');
  assert.match(text, /arguments bytes=\d+/);
});

test('add_facts 缺 projectRoot：同樣帶鍵清單（診斷不限於單一工具）', async () => {
  const { messages } = await runServer(
    ['--workspace-only'],
    [
      INIT,
      INITIALIZED,
      call(2, 'aim_memory_add_facts', {
        observations: [{ entityName: 'E', contents: ['x'] }],
      }),
    ],
    2,
  );
  const text: string = messages.find(m => m.id === 2).result.content[0].text;
  assert.match(text, /projectRoot is required/);
  assert.match(text, /tool=aim_memory_add_facts/);
  assert.match(text, /received keys: observations/);
});

test('arguments 送了空物件：訊息明說 (none)——與「只丟 projectRoot」可分辨', async () => {
  const { messages } = await runServer(
    ['--workspace-only'],
    [INIT, INITIALIZED, call(2, 'aim_memory_store', {})],
    2,
  );
  const text: string = messages.find(m => m.id === 2).result.content[0].text;
  assert.match(text, /received keys: \(none\)/);
});

// params 完全沒有 arguments 鍵。helpers 的 call() 一律帶 arguments，故此處手工組裝：
// 這正是客戶端橋接層「整包參數丟失」的形態，也是本次調查最該被記錄下來的一種。
const callWithoutArgumentsKey = (id: number, name: string) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name },
});

test('params 無 arguments 鍵：訊息仍帶診斷，且與 arguments:{} 分辨得開', async () => {
  const { messages } = await runServer(
    ['--workspace-only'],
    [INIT, INITIALIZED, callWithoutArgumentsKey(2, 'aim_memory_store')],
    2,
  );
  const text: string = messages.find(m => m.id === 2).result.content[0].text;
  assert.match(text, /No arguments provided for tool: aim_memory_store/);
  assert.match(text, /received keys: \(arguments key absent\)/);
});

test('未知工具名：訊息仍帶診斷（工具名損壞同樣是客戶端故障形態）', async () => {
  const { messages } = await runServer(
    ['--workspace-only'],
    [INIT, INITIALIZED, call(2, 'aim_memory_stroe', { projectRoot: '/tmp', entities: [] })],
    2,
  );
  const text: string = messages.find(m => m.id === 2).result.content[0].text;
  assert.match(text, /Unknown tool: aim_memory_stroe/);
  assert.match(text, /received keys: projectRoot,entities/);
});

// --- stderr 診斷輸出（stdio 整合） ------------------------------------------

// 拒絕路徑的 stderr 行。時間戳帶 +08:00 供與客戶端日誌對拍；reason 讓四種拒絕形態
// 可分別 grep；reqId 是 JSON-RPC 請求 id，客戶端日誌以它索引，缺了就只能靠毫秒時間戳
// 猜對應關係。
const stderrLine = (reason: string, reqId: number, tool: string, keys: string) =>
  new RegExp(
    String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00 \[aim-memory\] tool call rejected \(${reason}\) — reqId=${reqId}; \[diagnostic\] tool=${tool}; received keys: ${keys}; arguments bytes=\d+`,
  );

test('缺 projectRoot：stderr 行帶 reason、reqId、工具、鍵清單、字節數', async () => {
  const { stderr } = await runServer(
    ['--workspace-only'],
    [
      INIT,
      INITIALIZED,
      call(7, 'aim_memory_store', {
        entities: [{ name: 'E', entityType: 't', observations: ['x'] }],
      }),
    ],
    7,
  );
  assert.match(stderr, stderrLine('missing-project-root', 7, 'aim_memory_store', 'entities'));
});

test('params 無 arguments 鍵：stderr 留下紀錄（否則會被誤判為「請求根本沒到伺服器」）', async () => {
  const { stderr } = await runServer(
    ['--workspace-only'],
    [INIT, INITIALIZED, callWithoutArgumentsKey(5, 'aim_memory_store')],
    5,
  );
  assert.match(
    stderr,
    stderrLine('arguments-key-absent', 5, 'aim_memory_store', String.raw`\(arguments key absent\)`),
  );
});

test('未知工具名：stderr 留下紀錄', async () => {
  const { stderr } = await runServer(
    ['--workspace-only'],
    [INIT, INITIALIZED, call(6, 'aim_memory_stroe', { projectRoot: '/tmp' })],
    6,
  );
  assert.match(stderr, stderrLine('unknown-tool', 6, 'aim_memory_stroe', 'projectRoot'));
});

test('缺必填資料參數：stderr 行的 reason 與缺 projectRoot 分辨得開', async () => {
  const root = tmpRoot();
  const { stderr } = await runServer(
    ['--workspace-only'],
    [INIT, INITIALIZED, call(4, 'aim_memory_store', { projectRoot: root })],
    4,
  );
  assert.match(stderr, stderrLine('missing-required-args', 4, 'aim_memory_store', 'projectRoot'));
});

// --- 診斷檔案 sink（stdio 整合） --------------------------------------------

// 為何需要檔案 sink：實測 Devin 產生的 server 行程 FD2 直接指向 /dev/null
// （`lsof -p <pid>` 確認），stderr 那一行連同 reqId 全部被丟棄，「事後與客戶端日誌對拍」
// 在該客戶端上完全不成立。檔案 sink 讓紀錄不依賴客戶端如何處置 stderr。
// 預設關閉：未配置時不得產生任何檔案，否則會在使用者沒要求的地方留下垃圾。

test('--diagnostic-log：拒絕紀錄追寫到檔案，內容與 stderr 同一行', async () => {
  const root = tmpRoot();
  const logFile = path.join(root, 'diagnostic.log');
  const { stderr } = await runServer(
    ['--workspace-only', `--diagnostic-log=${logFile}`],
    [INIT, INITIALIZED, call(8, 'aim_memory_store', { entities: [] })],
    8,
  );
  const expected = stderrLine('missing-project-root', 8, 'aim_memory_store', 'entities');
  assert.match(stderr, expected, 'precondition: stderr 仍須照寫');
  assert.ok(existsSync(logFile), '配置了 sink 就必須產生檔案');
  assert.match(readFileSync(logFile, 'utf-8'), expected);
});

test('AIM_DIAGNOSTIC_LOG 環境變數形式同樣生效（MCP 設定檔多以 env 傳參）', async () => {
  const root = tmpRoot();
  const logFile = path.join(root, 'diagnostic-env.log');
  await runServer(
    ['--workspace-only'],
    [INIT, INITIALIZED, call(9, 'aim_memory_store', { entities: [] })],
    9,
    5000,
    { AIM_DIAGNOSTIC_LOG: logFile },
  );
  assert.ok(existsSync(logFile), '環境變數形式必須與 CLI 旗標等效');
  assert.match(
    readFileSync(logFile, 'utf-8'),
    stderrLine('missing-project-root', 9, 'aim_memory_store', 'entities'),
  );
});

test('診斷檔案為追寫而非覆寫——連續故障窗口的每一筆都要留下', async () => {
  const root = tmpRoot();
  const logFile = path.join(root, 'diagnostic-append.log');
  await runServer(
    ['--workspace-only', `--diagnostic-log=${logFile}`],
    [
      INIT,
      INITIALIZED,
      call(11, 'aim_memory_store', { entities: [] }),
      call(12, 'aim_memory_store', { entities: [] }),
    ],
    12,
  );
  const lines = readFileSync(logFile, 'utf-8').trim().split('\n');
  assert.equal(lines.length, 2, '兩次拒絕必須是兩行，後者不得覆蓋前者');
  assert.match(lines[0]!, /reqId=11;/);
  assert.match(lines[1]!, /reqId=12;/);
});

test('--diagnostic-log 超過大小上限時輪轉為單一 .1 備份（sink 不再無限增長）', async () => {
  // 追寫無上限曾讓診斷檔只增不減。診斷的價值在「最近那個失敗窗口」，
  // 舊紀錄邊際價值遞減，故越界時整檔輪轉為 .1（最多再留一代）。
  // 測法：先把 sink 墊到上限邊緣，一筆拒絕即迫使輪轉在本次寫入時發生。
  const root = tmpRoot();
  const logFile = path.join(root, 'diagnostic-rotate.log');
  writeFileSync(logFile, 'x'.repeat(DIAGNOSTIC_SINK_MAX_BYTES - 10));
  await runServer(
    ['--workspace-only', `--diagnostic-log=${logFile}`],
    [INIT, INITIALIZED, call(8, 'aim_memory_store', { entities: [] })],
    8,
  );
  assert.equal(
    statSync(`${logFile}.1`).size,
    DIAGNOSTIC_SINK_MAX_BYTES - 10,
    '上一代必須完整保留在 .1（rename 是整檔搬移）',
  );
  const current = readFileSync(logFile, 'utf-8');
  assert.match(current, /tool call rejected/, '本次紀錄進入輪轉後的新檔');
  assert.ok(statSync(logFile).size < 1000, '輪轉後新檔只含本次紀錄');
});

test('成功路徑不建立診斷檔案——未配置與已配置皆不得產生噪音', async () => {
  const root = tmpRoot();
  const logFile = path.join(root, 'diagnostic-quiet.log');
  const { messages } = await runServer(
    ['--workspace-only', `--diagnostic-log=${logFile}`],
    [
      INIT,
      INITIALIZED,
      call(2, 'aim_memory_store', {
        projectRoot: root,
        entities: [{ name: 'E', entityType: 't', observations: ['x'] }],
      }),
    ],
    2,
  );
  assert.ok(messages.find(m => m.id === 2)?.result?.isError !== true, 'precondition: 呼叫必須成功');
  assert.equal(existsSync(logFile), false, '沒有拒絕就不該有檔案');
});

test('成功路徑不寫診斷行——必然出現的信號不是信號', async () => {
  const root = tmpRoot();
  const { messages, stderr } = await runServer(
    ['--workspace-only'],
    [
      INIT,
      INITIALIZED,
      call(2, 'aim_memory_store', {
        projectRoot: root,
        entities: [{ name: 'E', entityType: 't', observations: ['x'] }],
      }),
    ],
    2,
  );
  assert.ok(messages.find(m => m.id === 2)?.result?.isError !== true, 'precondition: 呼叫必須成功');
  assert.doesNotMatch(stderr, /tool call rejected/);
});
