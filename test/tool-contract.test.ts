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

import { TOOL_DEFINITIONS, buildToolDefinitions } from '../tools.js';
import { TOOL_HANDLERS, suggestToolName, suggestKeyFix, dispatchTool } from '../server.js';
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

test('每個工具都帶完整 annotations：7 唯讀 / 3 純附加 / 5 破壞性，全部封閉世界', () => {
  // 分類依據執行期行為（非描述文字）：
  // - 唯讀 ×7：不碰圖譜。
  // - 純附加 ×3：store 跳過既有名、link 去重、add_facts 去重，重放同參數無額外效果。
  //   （add_facts 的 upsertKeyed 會刪同鍵行，但那是呼叫端逐 entry 顯式 opt-in，
  //   淨效果是「狀態槽歸一」；工具本性是附加。）
  // - 破壞性 ×5：forget / remove_facts / unlink / replace_fact 重放無額外效果（idempotent）；
  //   update_entity 的 rename 無法重放（第二次舊名已不存在 → 報錯），idempotentHint 必須是 false。
  // 新增工具若漏設 annotations，或改動分類而未同步此表，此測試立刻變紅。
  const readOnly = [
    'aim_memory_read_all',
    'aim_memory_search',
    'aim_memory_get',
    'aim_memory_count_observations',
    'aim_memory_list_stores',
    'aim_memory_doctor',
    'aim_memory_list_entity_types',
  ];
  const additive = ['aim_memory_store', 'aim_memory_add_facts', 'aim_memory_link'];
  const destructiveIdempotent = [
    'aim_memory_forget',
    'aim_memory_remove_facts',
    'aim_memory_unlink',
    'aim_memory_replace_fact',
  ];
  const destructiveNonIdempotent = ['aim_memory_update_entity'];

  const classified = [
    ...readOnly,
    ...additive,
    ...destructiveIdempotent,
    ...destructiveNonIdempotent,
  ];
  assert.deepEqual(
    TOOL_DEFINITIONS.map(t => t.name).sort(),
    classified.slice().sort(),
    '每個工具都必須在下列四個分類中恰好出現一次（新增工具須先分類）',
  );

  for (const tool of TOOL_DEFINITIONS) {
    const a = tool.annotations;
    assert.ok(a, `${tool.name} 缺少 annotations`);
    assert.equal(a.openWorldHint, false, `${tool.name} 作用域是本地 JSONL 圖譜（封閉世界）`);
    const expectReadOnly = readOnly.includes(tool.name);
    assert.equal(a.readOnlyHint, expectReadOnly, `${tool.name} 的 readOnlyHint`);
    const expectDestructive =
      destructiveIdempotent.includes(tool.name) || destructiveNonIdempotent.includes(tool.name);
    assert.equal(a.destructiveHint, expectDestructive, `${tool.name} 的 destructiveHint`);
    const expectIdempotent = !destructiveNonIdempotent.includes(tool.name);
    assert.equal(a.idempotentHint, expectIdempotent, `${tool.name} 的 idempotentHint`);
  }
});

test('workspace-only 的 schema 後處理不剝除 annotations（stdio 實測 tools/list）', async () => {
  // annotations 與 description/inputSchema 同在工具物件上；尾段的 workspace-only
  // 改寫迴圈只該碰後兩者。此測試走真實子行程的 tools/list，
  // 防未來有人在後處理裡重建工具物件時把 annotations 丟掉。
  const out = await driveServer(
    ['--workspace-only'],
    [INIT, INITIALIZED, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }],
    2,
  );
  const tools: any[] = out.find(m => m.id === 2).result.tools;
  assert.equal(tools.length, TOOL_DEFINITIONS.length);
  for (const t of tools) {
    assert.ok(t.annotations, `${t.name} 的 annotations 在 workspace-only 模式下被剝除`);
    assert.equal(typeof t.annotations.readOnlyHint, 'boolean', `${t.name} 缺 readOnlyHint`);
    assert.equal(t.annotations.openWorldHint, false, `${t.name} 的 openWorldHint 被改寫`);
  }
});

test('formatProp 宣告的格式必須全部出現在工具描述中（模型只學描述列出者）', () => {
  // search/get 的描述曾只列 json/pretty，而共用的 formatProp 宣告了三種（含 concise）——
  // 模型因此只學到 2/3 的能力。描述與 schema 再度漂移時此測試變紅。
  for (const tool of TOOL_DEFINITIONS) {
    const props = (tool.inputSchema as any).properties ?? {};
    const format = props.format;
    if (!format || !Array.isArray(format.enum)) continue;
    for (const fmt of format.enum) {
      assert.ok(
        tool.description!.includes(`"${fmt}"`),
        `${tool.name} 的描述未列出 format: "${fmt}"（schema 有宣告，模型學不到）`,
      );
    }
  }
});

test('buildToolDefinitions：workspace-only 後處理以副本進行，基底定義永不被改寫', () => {
  // 舊實作在 import 時就改寫已匯出的 TOOL_DEFINITIONS（隱式全域可變狀態——
  // export const 的 const 只保護綁定不保護內容），使同一行程無法同時服務兩種模式，
  // 所有 workspace-only 測試被迫 spawn 子行程。工廠化後後處理產生新物件，
  // 基底陣列保持非嚴格模式的樣子，兩種視圖可在同一行程共存。
  const processed = buildToolDefinitions(true);
  const base = TOOL_DEFINITIONS.find(t => t.name === 'aim_memory_store')!;
  const strict = processed.find(t => t.name === 'aim_memory_store')!;
  // 嚴格副本：projectRoot 必填、location 移除、描述帶公告、annotations 保留。
  assert.ok((strict.inputSchema as any).required.includes('projectRoot'));
  assert.equal((strict.inputSchema as any).properties.location, undefined);
  assert.match(strict.description!, /^\[workspace-only mode\]/);
  assert.equal(strict.annotations?.readOnlyHint, false, '後處理不得剝除 annotations');
  // 基底原樣：required 無 projectRoot、location 仍在、描述無公告。
  const baseRequired = (base.inputSchema as any).required as string[] | undefined;
  assert.ok(
    baseRequired === undefined || !baseRequired.includes('projectRoot'),
    '基底的 required 不得被寫入 projectRoot',
  );
  assert.ok((base.inputSchema as any).properties.location, '基底定義的 location 不得被剝除');
  assert.doesNotMatch(base.description!, /^\[workspace-only mode\]/);
  // 非嚴格模式回傳基底本身（零拷貝、零改寫）。
  assert.equal(buildToolDefinitions(false), TOOL_DEFINITIONS);
});

test('dispatchTool 可注入處理器表（DIP）：假存儲直通，不再硬綁 knowledgeGraphManager 單例', async () => {
  // 類別早就有 workspaceOnly 建構子 seam，缺的是模組邊界這層：派發表曾直接
  // close over 單例，dispatchTool 無法對假存儲做單元測試，五個測試檔被迫全走
  // spawn 子行程。注入第三參數後，派發接線（名稱解析 → 驗證 → 處理器）可在
  // 行程內對假表驗證；預設值保留正式路徑的單例行為（呼叫端零改動）。
  const marker = 'fake-store-answer';
  const fake = Object.fromEntries(
    Object.keys(TOOL_HANDLERS).map(name => [
      name,
      async () => ({ content: [{ type: 'text', text: marker }] }),
    ]),
  );
  const result = await dispatchTool(
    { method: 'tools/call', params: { name: 'aim_memory_read_all', arguments: {} } } as any,
    1,
    fake,
  );
  assert.ok(
    JSON.stringify(result).includes(marker),
    '注入的假處理器必須被呼叫，而非單例的真實存儲',
  );
});

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
