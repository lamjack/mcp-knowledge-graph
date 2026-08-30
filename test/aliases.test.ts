// 工具名與參數名的 alias 解析：根治實測到的呼叫失敗，而非只把錯誤訊息寫好。
//
// 成因（依 55 筆真實診斷紀錄逐筆分類，並與官方 memory server README 對拍）：
//   1. 工具名背離上游生態名（search_nodes ×9、open_nodes ×1 逐字等於上游名）+ 掉前綴（×2）
//   2. `recall` 來自 memory-graph-curation skill 的 phase 名，被當成工具名（×6）
//   3. fork 自身參數詞彙不一致：get 要 names 卻收到 name（×11，單一實體是最常見用法）
//      或 entityName（×3，那是同一 server 內 add_facts/remove_facts 的詞彙）；
//      forget 要 entityNames 收到 names（×2）；add_facts 工具名說 facts 參數卻叫 observations（×1）
//   4. replace_fact 不存在於上游，模型自創 oldFact/newFact——它要的是「換掉這段原文」，
//      而工具只有 prefix/substring。屬能力缺口，故新增 matchExact
//
// ⚠️ 上游參數名（names / entityNames / observations / deletions / query / entities）與本 fork
// **完全一致**，所以 canonical 名稱刻意不改：改成第三套詞彙只會讓生態先驗失效。
// alias 只做「接受」，回應前置 [alias] 抬頭告知正名——不製造隱藏契約，且模型當場學會。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveToolName, applyParamAliases } from '../server.js';
import { TOOL_DEFINITIONS, TOOL_NAME_ALIASES, PARAM_ALIASES } from '../tools.js';
import { KnowledgeGraphManager } from '../storage.js';
import { INIT, INITIALIZED, call, driveServer, tmpRoot as makeTmpRoot } from './helpers.js';

function tmpRoot(): string {
  return makeTmpRoot('kg-alias-');
}

function schemaOf(name: string): any {
  return TOOL_DEFINITIONS.find(t => t.name === name)!.inputSchema;
}

// alias 表本身的完整性守衛。沒有它，重新命名任何工具或參數都會讓 alias 靜默失效：
// 工具名 alias 指向不存在的工具 → resolveToolName 回 undefined → 呼叫端拿到
// 「Unknown tool」，而真正的原因是 alias 表過時；參數 alias 指向不存在的參數 →
// shapeOfProp 得到 'other' → fitsShape 一律放行 → 寫進一個 schema 沒宣告的鍵，
// 之後在更深處以更含糊的方式失敗。兩者都是「表與定義漂移」，與 dispatchTool 的
// switch/定義漂移（R-001）同一類，必須用同樣的方式釘死。
test('alias 表完整性：每個工具名 alias 的目標都是真實存在的 canonical 工具', () => {
  const canonical = new Set(TOOL_DEFINITIONS.map(t => t.name));
  for (const [alias, target] of Object.entries(TOOL_NAME_ALIASES)) {
    assert.ok(canonical.has(target), `alias "${alias}" 指向不存在的工具 "${target}"`);
    assert.equal(
      canonical.has(alias),
      false,
      `"${alias}" 同時是 canonical 工具名，alias 表不得遮蔽它`,
    );
  }
});

test('alias 表完整性：每個參數 alias 的工具與目標參數都真實存在', () => {
  for (const [toolName, table] of Object.entries(PARAM_ALIASES)) {
    const tool = TOOL_DEFINITIONS.find(t => t.name === toolName);
    assert.ok(tool, `PARAM_ALIASES 提到不存在的工具 "${toolName}"`);
    const props = (tool!.inputSchema as any).properties ?? {};
    for (const [alias, target] of Object.entries(table)) {
      assert.ok(
        Object.hasOwn(props, target),
        `${toolName} 的 alias "${alias}" 指向 schema 沒有的參數 "${target}"`,
      );
      assert.equal(
        Object.hasOwn(props, alias),
        false,
        `${toolName} 的 "${alias}" 本身就是合法參數，不該被當成 alias 改寫`,
      );
    }
  }
});

test('resolveToolName：九個上游官方工具名全部對回 canonical', () => {
  const upstream: [string, string][] = [
    ['aim_memory_create_entities', 'aim_memory_store'],
    ['aim_memory_create_relations', 'aim_memory_link'],
    ['aim_memory_add_observations', 'aim_memory_add_facts'],
    ['aim_memory_delete_entities', 'aim_memory_forget'],
    ['aim_memory_delete_observations', 'aim_memory_remove_facts'],
    ['aim_memory_delete_relations', 'aim_memory_unlink'],
    ['aim_memory_read_graph', 'aim_memory_read_all'],
    ['aim_memory_search_nodes', 'aim_memory_search'],
    ['aim_memory_open_nodes', 'aim_memory_get'],
  ];
  for (const [alias, canonical] of upstream) {
    assert.equal(resolveToolName(alias), canonical, `${alias} 應對回 ${canonical}`);
  }
});

test('resolveToolName：掉了 aim_memory_ 前綴的名稱（含上游名的無前綴形式）都能補回', () => {
  assert.equal(resolveToolName('search'), 'aim_memory_search');
  assert.equal(resolveToolName('list_stores'), 'aim_memory_list_stores');
  assert.equal(resolveToolName('read_graph'), 'aim_memory_read_all');
  assert.equal(resolveToolName('open_nodes'), 'aim_memory_get');
});

test('resolveToolName：recall / read 對回 read_all（recall 是 skill 的 phase 名）', () => {
  assert.equal(resolveToolName('aim_memory_recall'), 'aim_memory_read_all');
  assert.equal(resolveToolName('recall'), 'aim_memory_read_all');
  assert.equal(resolveToolName('aim_memory_read'), 'aim_memory_read_all');
});

test('resolveToolName：canonical 名稱原樣回傳；無從對應者回 undefined', () => {
  assert.equal(resolveToolName('aim_memory_doctor'), 'aim_memory_doctor');
  assert.equal(resolveToolName('aim_memory_wibble_wobble'), undefined);
});

test('applyParamAliases：get 的 name / entityName 對回 names，且單一字串自動包成陣列', () => {
  const schema = schemaOf('aim_memory_get');
  const a = applyParamAliases('aim_memory_get', { name: 'Alice', projectRoot: '/x' }, schema);
  assert.deepEqual(a.args.names, ['Alice'], '單一實體是最常見用法，字串須包成陣列');
  assert.deepEqual(a.renamed, [['name', 'names']]);

  const b = applyParamAliases(
    'aim_memory_get',
    { entityName: ['A', 'B'], projectRoot: '/x' },
    schema,
  );
  assert.deepEqual(b.args.names, ['A', 'B']);
  assert.deepEqual(b.renamed, [['entityName', 'names']]);
});

test('applyParamAliases：forget 的 names 對回 entityNames；search 的 search 對回 query', () => {
  const f = applyParamAliases(
    'aim_memory_forget',
    { names: ['Old'], projectRoot: '/x' },
    schemaOf('aim_memory_forget'),
  );
  assert.deepEqual(f.args.entityNames, ['Old']);

  const s = applyParamAliases(
    'aim_memory_search',
    { search: 'timezone', projectRoot: '/x' },
    schemaOf('aim_memory_search'),
  );
  assert.equal(s.args.query, 'timezone');
});

test('applyParamAliases：add_facts 的 facts 對回 observations（工具名說 facts、參數叫 observations）', () => {
  const payload = [{ entityName: 'E', contents: ['x'] }];
  const r = applyParamAliases(
    'aim_memory_add_facts',
    { facts: payload, projectRoot: '/x' },
    schemaOf('aim_memory_add_facts'),
  );
  assert.deepEqual(r.args.observations, payload);
});

test('applyParamAliases：replace_fact 的 oldFact/newFact 對回 matchExact/newText', () => {
  const r = applyParamAliases(
    'aim_memory_replace_fact',
    { entityName: 'E', oldFact: '舊事實', newFact: '新事實', projectRoot: '/x' },
    schemaOf('aim_memory_replace_fact'),
  );
  assert.equal(r.args.matchExact, '舊事實');
  assert.equal(r.args.newText, '新事實');
  assert.equal(r.args.oldFact, undefined, 'alias 鍵須被移除，否則 XOR 檢查會誤判');
});

test('applyParamAliases：shape 不符時不改寫（避免把清楚的錯誤變成含糊的錯誤）', () => {
  // remove_facts 的 deletions 是「物件陣列」；若呼叫端把 observations 送成字串陣列，
  // 改名只會讓它在更深處以更含糊的訊息失敗，故此時保持原樣讓正常的缺參數錯誤發生。
  const r = applyParamAliases(
    'aim_memory_remove_facts',
    { observations: ['一段純字串'], projectRoot: '/x' },
    schemaOf('aim_memory_remove_facts'),
  );
  assert.equal(r.args.deletions, undefined, 'shape 不符不得改寫');
  assert.deepEqual(r.renamed, []);
});

test('applyParamAliases：canonical 參數已存在時，alias 不得覆蓋它', () => {
  const r = applyParamAliases(
    'aim_memory_get',
    { names: ['正確的'], name: '不該覆蓋', projectRoot: '/x' },
    schemaOf('aim_memory_get'),
  );
  assert.deepEqual(r.args.names, ['正確的']);
  assert.deepEqual(r.renamed, []);
});

test('replaceFact 的 matchExact 只命中逐字相同者（不像 substring 那樣過度命中）', async () => {
  const root = tmpRoot();
  const m = new KnowledgeGraphManager(true);
  await m.createEntities(
    [{ name: 'E', entityType: 'concept', observations: ['狀態: 好', '狀態: 好極了'] }],
    undefined,
    undefined,
    root,
  );
  const res = await m.replaceFact(
    'E',
    { exact: '狀態: 好' },
    '狀態: 普通',
    undefined,
    undefined,
    root,
  );
  assert.equal(res.matched, 1, 'matchExact 不得命中「狀態: 好極了」——那正是 substring 會誤刪的');
  const graph = await m.readGraph(undefined, undefined, root);
  assert.deepEqual(graph.entities[0]!.observations, ['狀態: 好極了', '狀態: 普通']);
});

test('replaceFact：三種 match 模式恰擇一，給兩個要報錯', async () => {
  const root = tmpRoot();
  const m = new KnowledgeGraphManager(true);
  await m.createEntities(
    [{ name: 'E', entityType: 'concept', observations: ['a'] }],
    undefined,
    undefined,
    root,
  );
  await assert.rejects(
    () => m.replaceFact('E', { exact: 'a', prefix: 'a' }, 'b', undefined, undefined, root),
    /exactly one/i,
  );
});

// ⚠️ 寫入與讀取必須分開 session：讀取路徑不走 write chain（runExclusive 只序列化寫入），
// 同批送出時讀取會先跑完而看到空圖。此慣例已記於 AGENTS.md，與 observation-ops 等測試一致。
async function seed(root: string, entities: object[]): Promise<void> {
  const out = await driveServer(
    ['--workspace-only'],
    [INIT, INITIALIZED, call(2, 'aim_memory_store', { projectRoot: root, entities })],
    2,
  );
  const resp = out.find(m => m.id === 2);
  assert.ok(
    resp?.result && !resp.result.isError,
    `precondition: seed 必須成功，實得 ${JSON.stringify(resp)}`,
  );
}

test('stdio：上游工具名 aim_memory_search_nodes 直接可用，並前置 [alias] 抬頭告知正名', async () => {
  const root = tmpRoot();
  await seed(root, [{ name: 'Zeta', entityType: 'concept', observations: ['時區相關'] }]);

  const out = await driveServer(
    ['--workspace-only'],
    [INIT, INITIALIZED, call(2, 'aim_memory_search_nodes', { projectRoot: root, query: '時區' })],
    2,
  );
  const resp = out.find(m => m.id === 2);
  assert.ok(
    resp?.result && !resp.result.isError,
    `上游名稱應可用，實得: ${JSON.stringify(resp?.result)}`,
  );
  const text: string = resp.result.content[0].text;
  assert.match(text, /\[alias\]/, '須告知這是 alias');
  assert.match(text, /aim_memory_search\b/, '須指出 canonical 工具名');
  assert.match(text, /Zeta/, '仍須回傳正確結果');
});

test('stdio：get 用 name 單數直接可用，並告知正名', async () => {
  const root = tmpRoot();
  await seed(root, [{ name: 'Solo', entityType: 'concept', observations: ['x'] }]);

  const out = await driveServer(
    ['--workspace-only'],
    [INIT, INITIALIZED, call(2, 'aim_memory_get', { projectRoot: root, name: 'Solo' })],
    2,
  );
  const resp = out.find(m => m.id === 2);
  assert.ok(
    resp?.result && !resp.result.isError,
    `name 單數應可用，實得: ${JSON.stringify(resp?.result)}`,
  );
  const text: string = resp.result.content[0].text;
  assert.match(text, /\[alias\]/);
  assert.match(text, /"name" -> "names"/, '須指出參數的正名');
  assert.match(text, /Solo/);
});

test('stdio：replace_fact 用 oldFact/newFact 直接可用（走 matchExact）', async () => {
  const root = tmpRoot();
  await seed(root, [{ name: 'R', entityType: 'concept', observations: ['版本: v1'] }]);

  const repOut = await driveServer(
    ['--workspace-only'],
    [
      INIT,
      INITIALIZED,
      call(2, 'aim_memory_replace_fact', {
        projectRoot: root,
        entityName: 'R',
        oldFact: '版本: v1',
        newFact: '版本: v2',
      }),
    ],
    2,
  );
  const rep = repOut.find(m => m.id === 2);
  assert.ok(
    rep?.result && !rep.result.isError,
    `oldFact/newFact 應可用，實得: ${JSON.stringify(rep?.result)}`,
  );
  assert.match(rep.result.content[0].text, /"matched": 1/, '須確實命中一條（matchExact）');

  const after: string = (
    await driveServer(
      ['--workspace-only'],
      [INIT, INITIALIZED, call(2, 'aim_memory_get', { projectRoot: root, names: ['R'] })],
      2,
    )
  ).find(m => m.id === 2).result.content[0].text;
  assert.match(after, /版本: v2/);
  assert.doesNotMatch(after, /版本: v1/);
});

test('stdio：canonical 呼叫不得出現 [alias] 抬頭（必然出現的信號不是信號）', async () => {
  const root = tmpRoot();
  await seed(root, [{ name: 'C', entityType: 'concept', observations: ['x'] }]);

  const out = await driveServer(
    ['--workspace-only'],
    [INIT, INITIALIZED, call(2, 'aim_memory_get', { projectRoot: root, names: ['C'] })],
    2,
  );
  const text: string = out.find(m => m.id === 2).result.content[0].text;
  assert.match(text, /C/, 'precondition: 必須真的讀到資料，否則此斷言會僥倖通過');
  assert.doesNotMatch(text, /\[alias\]/);
});

test('stdio：完全無從對應的工具名仍被拒絕（alias 不得變成什麼都收）', async () => {
  const root = tmpRoot();
  const out = await driveServer(
    ['--workspace-only'],
    [INIT, INITIALIZED, call(2, 'aim_memory_wibble_wobble', { projectRoot: root })],
    2,
  );
  const resp = out.find(m => m.id === 2);
  assert.equal(resp.result.isError, true);
  assert.match(resp.result.content[0].text, /Unknown tool: aim_memory_wibble_wobble/);
});
