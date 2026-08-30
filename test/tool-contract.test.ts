// 工具契約守衛：把「宣告的 schema」與「實際能執行的處理器」綁在一起，並讓兩條
// 拒絕路徑自帶修正線索。三組測試各對應一個實測到的缺陷：
//
//   1. 派發表 ↔ 工具定義必須完全對應。過去 dispatchTool 是 15 case 的 switch，
//      而 assertToolCallArgs 只認 TOOL_DEFINITIONS：新增工具卻忘了接線時，請求會落到
//      switch 的 default 丟出「Unknown tool」——它是已知工具，訊息語義錯誤，
//      而且繞過 rejectToolCall 因此無診斷抬頭、無 stderr、無檔案 sink 紀錄，
//      直接違反「每一條拒絕路徑都留紀錄」的契約。此測試讓漂移在編譯後立刻變紅。
//   2. 「恰擇一 / 至多一」的參數約束必須寫進對外 schema。過去它們只在執行期強制，
//      呼叫端只能靠失敗學習——真實診斷日誌裡 replace_fact 有 6 筆猜錯參數名。
//   3. 拒絕訊息必須帶可執行線索（最接近的工具名、完整工具清單、拼錯的鍵）。
//      成本考量：宿主在工具錯誤時會附上整份 tools/list（實測 40KB），
//      因此在訊息裡放幾百字元的線索，遠比讓呼叫端多錯一輪便宜。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TOOL_DEFINITIONS } from '../tools.js';
import { TOOL_HANDLERS, suggestToolName, suggestKeyFix } from '../server.js';
import { INIT, INITIALIZED, call, driveServer, tmpRoot as makeTmpRoot } from './helpers.js';

function tmpRoot(): string {
  return makeTmpRoot('kg-contract-');
}

// 取某工具的 inputSchema（測試在非嚴格模式下執行，schema 未被 workspace-only 改寫）。
function schemaOf(name: string): any {
  const tool = TOOL_DEFINITIONS.find(t => t.name === name);
  assert.ok(tool, `工具定義不存在: ${name}`);
  return tool!.inputSchema as any;
}

test('派發表與工具定義完全對應：宣告了就一定能執行，能執行的一定有宣告', () => {
  const declared = TOOL_DEFINITIONS.map(t => t.name).sort();
  const dispatchable = Object.keys(TOOL_HANDLERS).sort();
  assert.deepEqual(
    dispatchable,
    declared,
    '每個 TOOL_DEFINITIONS 名稱都必須有處理器，且處理器不得多於宣告' +
      '（多出來的名稱永遠收不到請求，因為 assertToolCallArgs 只認 TOOL_DEFINITIONS）',
  );
});

test('remove_facts 的 deletion entry 把「observations / observationPrefix 恰擇一」寫進 schema', () => {
  const item = schemaOf('aim_memory_remove_facts').properties.deletions.items;
  assert.ok(Array.isArray(item.oneOf), 'deletion entry 需以 oneOf 宣告恰擇一');
  const required = item.oneOf.map((b: any) => b.required?.[0]).sort();
  assert.deepEqual(required, ['observationPrefix', 'observations']);
});

test('replace_fact 把「matchExact / matchPrefix / matchSubstring 恰擇一」寫進 schema', () => {
  const schema = schemaOf('aim_memory_replace_fact');
  assert.ok(Array.isArray(schema.oneOf), 'replace_fact 需以 oneOf 宣告恰擇一');
  const required = schema.oneOf.map((b: any) => b.required?.[0]).sort();
  // matchExact 是後來補上的能力：實測 6 筆失敗都在表達「把這段原文換掉」，
  // 而當時只有 prefix/substring，拿 substring 硬代替會過度命中。
  assert.deepEqual(required, ['matchExact', 'matchPrefix', 'matchSubstring']);
});

test('get 把「observationPrefix / observationSubstring 至多一」寫進 schema', () => {
  const schema = schemaOf('aim_memory_get');
  // 兩者皆可省略，故正確表達是「不得同時出現」而非 oneOf。
  assert.deepEqual(
    schema.not?.required?.slice().sort(),
    ['observationPrefix', 'observationSubstring'],
    'get 需以 not.required 宣告兩者不得並存',
  );
});

test('數值參數在 schema 宣告下界，不再只靠伺服器端靜默夾值', () => {
  const readAll = schemaOf('aim_memory_read_all').properties;
  const search = schemaOf('aim_memory_search').properties;
  assert.equal(readAll.offset.minimum, 0);
  assert.equal(readAll.limit.minimum, 0);
  assert.equal(search.limit.minimum, 0);
  assert.equal(search.depth.minimum, 0);
});

test('suggestToolName：純拼錯能對回正確工具，無從推測者回 undefined', () => {
  const names = TOOL_DEFINITIONS.map(t => t.name);
  // ⚠️ 上游標準名（search_nodes / open_nodes / read_graph）與掉前綴的變體現在由
  // resolveToolName 的 alias 表直接對回 canonical 並成功執行，**不會走到這裡**
  // （見 test/aliases.test.ts）。此函式只服務「真的無法對應」的名稱，
  // 因此以下用例刻意都不在 alias 表內。
  assert.equal(suggestToolName('aim_memory_stroe', names), 'aim_memory_store', '編輯距離 2 的拼錯');
  assert.equal(suggestToolName('aim_memory_doctorr', names), 'aim_memory_doctor');
  // 無從推測者必須回 undefined，不可硬湊一個把呼叫端導向錯誤工具（其中有破壞性工具）。
  assert.equal(suggestToolName('aim_memory_wibble_wobble', names), undefined);
});

test('suggestKeyFix：把「送來的鍵」對回「schema 要的鍵」', () => {
  assert.equal(suggestKeyFix('names', ['name', 'projectRoot']), 'name');
  assert.equal(suggestKeyFix('entityNames', ['names', 'projectRoot']), 'names');
  assert.equal(suggestKeyFix('newText', ['newFact', 'oldFact']), undefined);
});

test('未知工具的拒絕訊息附最接近的工具名與完整工具清單（stdio 實測）', async () => {
  const root = tmpRoot();
  // 用真正無法對應的拼錯名稱：alias 表能對回的（如 aim_memory_search_nodes）
  // 現在會直接成功執行，不再走拒絕路徑。
  const out = await driveServer(
    ['--workspace-only'],
    [INIT, INITIALIZED, call(2, 'aim_memory_stroe', { projectRoot: root, entities: [] })],
    2,
  );
  const text: string = out.find(m => m.id === 2).result.content[0].text;
  assert.match(text, /Unknown tool: aim_memory_stroe/);
  assert.match(text, /did you mean "aim_memory_store"/i, '需指出最接近的正確工具名');
  assert.match(text, /aim_memory_read_all/, '需附完整工具清單供呼叫端自行對照');
});

test('缺必填參數時，若送來的鍵疑似拼錯，訊息指出該對應哪個鍵（stdio 實測）', async () => {
  const root = tmpRoot();
  // 用未列入 alias 的鍵：get 的 name 現在會直接被對回 names 並成功。
  // count_observations 的 observationPrefix 沒有 alias，送 prefix 仍會（且應該）失敗。
  const out = await driveServer(
    ['--workspace-only'],
    [
      INIT,
      INITIALIZED,
      call(2, 'aim_memory_count_observations', {
        projectRoot: root,
        names: ['E'],
        prefix: 'session ',
      }),
    ],
    2,
  );
  const text: string = out.find(m => m.id === 2).result.content[0].text;
  assert.match(
    text,
    /Missing required argument\(s\) for aim_memory_count_observations: observationPrefix/,
  );
  assert.match(text, /received "prefix"/, '需指出送來的那個疑似拼錯的鍵');
});
