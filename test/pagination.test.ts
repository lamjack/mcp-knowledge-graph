// Tests for the large-graph safety features that prevent the MCP client from
// erroring on oversized read results ("Encountered unexpected error during
// execution"):
//   1. paginateGraph     - slice entities via offset/limit, relations kept whole
//   2. capText           - hard output-size cap (defense-in-depth net)
//   3. autoPaginateText  - unpaginated overflow degrades to a well-formed first page
//   4. read_all over stdio honours offset/limit and emits a pagination header
//   5. --max-output-chars truncates oversized read output with guidance

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { paginateGraph, capText, autoPaginateText } from '../server.js';
import type { KnowledgeGraph } from '../storage.js';
import { INIT, INITIALIZED, call, driveServer, tmpRoot as makeTmpRoot } from './helpers.js';

function tmpRoot(): string {
  return makeTmpRoot('kg-page-');
}

function makeGraph(n: number): KnowledgeGraph {
  const entities = Array.from({ length: n }, (_, i) => ({
    name: `E${i}`,
    entityType: 't',
    observations: [`obs${i}`],
  }));
  const relations = n >= 2 ? [{ from: 'E0', to: 'E1', relationType: 'r' }] : [];
  return { entities, relations };
}

// --- paginateGraph ---------------------------------------------------------

test('paginateGraph: no offset/limit -> unpaginated (pageInfo null, graph unchanged)', () => {
  const g = makeGraph(5);
  const { graph, pageInfo } = paginateGraph(g, undefined, undefined);
  assert.equal(pageInfo, null);
  assert.equal(graph.entities.length, 5);
});

test('paginateGraph: limit slices entities and keeps all relations', () => {
  const g = makeGraph(5);
  const { graph, pageInfo } = paginateGraph(g, undefined, 2);
  assert.deepEqual(
    graph.entities.map(e => e.name),
    ['E0', 'E1'],
  );
  assert.equal(graph.relations.length, 1, 'relations are the cheap skeleton, kept whole');
  assert.ok(pageInfo);
  assert.equal(pageInfo!.total, 5);
  assert.equal(pageInfo!.count, 2);
  assert.equal(pageInfo!.hasMore, true);
  assert.equal(pageInfo!.nextOffset, 2);
});

test('paginateGraph: offset walks the list; final page reports no more', () => {
  const g = makeGraph(5);
  const { graph, pageInfo } = paginateGraph(g, 4, 2);
  assert.deepEqual(
    graph.entities.map(e => e.name),
    ['E4'],
  );
  assert.equal(pageInfo!.hasMore, false);
  assert.equal(pageInfo!.nextOffset, null);
});

test('paginateGraph: offset beyond end yields an empty page, not an error', () => {
  const g = makeGraph(3);
  const { graph, pageInfo } = paginateGraph(g, 10, 5);
  assert.equal(graph.entities.length, 0);
  assert.equal(pageInfo!.hasMore, false);
});

test('paginateGraph: garbage offset/limit (NaN/negative) is normalised safely', () => {
  const g = makeGraph(3);
  const { pageInfo } = paginateGraph(g, -5, Number.NaN);
  // negative offset -> 0, NaN limit -> no limit, but offset<=0 & no limit => unpaginated
  assert.equal(pageInfo, null);
});

// --- capText ---------------------------------------------------------------

test('capText: returns input unchanged when under the limit', () => {
  const s = 'hello';
  assert.equal(capText(s, 100), s);
});

test('capText: truncates oversized text, stays within the cap, and appends guidance', () => {
  const s = 'x'.repeat(1000);
  const out = capText(s, 200);
  assert.ok(out.length <= 200, `capped length ${out.length} must be <= 200`);
  assert.match(out, /truncated/);
  assert.match(out, /offset\/limit/);
});

test('capText: 極小上限（notice 放不下）時純硬切，輸出絕不超限', () => {
  // 硬上限是對客戶端的保證（輸出絕不超過 max）。notice 本身約 180 字元，
  // max 小於它時「截斷 + 附指引」會讓輸出超出自己的預算——指引放不下的預算裡，
  // 塞半截 notice 一樣是破損內容，純硬切是唯一不破保證的做法。
  const s = 'x'.repeat(1000);
  assert.equal(capText(s, 50).length, 50, 'max 小於 notice 長度時輸出仍不得超過 max');
  assert.equal(capText(s, 0).length, 0, 'max=0 時輸出為空');
});

// --- autoPaginateText ------------------------------------------------------

test('autoPaginateText: returns null when not even one entity fits the budget', () => {
  const g = makeGraph(3);
  assert.equal(autoPaginateText(g, 'concise', undefined, 10), null);
});

test('autoPaginateText: fits the maximal whole-entity prefix under the budget', () => {
  const g = makeGraph(6);
  // Hand-derived: each entity adds exactly 15 chars in concise format (14-char line
  // + newline), so a budget fitting the 2-entity page exactly rejects 3 entities,
  // and one char less drops to a single entity.
  const twoPage = [
    '[page] entities 0-2 of 6 — more available: call read_all again with offset=2',
    '=== default database (concise) ===',
    'ENTITIES (2):',
    '- E0 (t): obs0',
    '- E1 (t): obs1',
    'RELATIONS (1):',
    '- E0 -[r]-> E1',
  ].join('\n');
  assert.equal(autoPaginateText(g, 'concise', undefined, twoPage.length), twoPage);

  const onePage = [
    '[page] entities 0-1 of 6 — more available: call read_all again with offset=1',
    '=== default database (concise) ===',
    'ENTITIES (1):',
    '- E0 (t): obs0',
    'RELATIONS (1):',
    '- E0 -[r]-> E1',
  ].join('\n');
  assert.equal(autoPaginateText(g, 'concise', undefined, twoPage.length - 1), onePage);
});

test('autoPaginateText: json payload stays parseable and retains the full relation skeleton', () => {
  const g = makeGraph(6);
  // Budget one char below the full serialization forces auto-pagination; the
  // 5-entity page (header + JSON minus one entity block) must still fit.
  const full = JSON.stringify(g, null, 2);
  const out = autoPaginateText(g, undefined, undefined, full.length - 1);
  assert.ok(out, 'expected an auto-paginated page, not null');
  const nl = out!.indexOf('\n');
  const header = out!.slice(0, nl);
  assert.match(
    header,
    /^\[page\] entities 0-5 of 6 — more available: call read_all again with offset=5$/,
  );
  const parsed = JSON.parse(out!.slice(nl + 1));
  assert.deepEqual(parsed, { entities: g.entities.slice(0, 5), relations: g.relations });
});

// --- stdio integration -----------------------------------------------------

// 驅動碼集中於 ./helpers.js（與 tool-errors / observation-ops 共用）。

const storeMany = (id: number, root: string, n: number, obsLen = 0) =>
  call(id, 'aim_memory_store', {
    projectRoot: root,
    entities: Array.from({ length: n }, (_, i) => ({
      name: `E${i}`,
      entityType: 't',
      observations: [obsLen > 0 ? 'x'.repeat(obsLen) : `obs${i}`],
    })),
  });

// Persist in one server session, then read in a second. Reads are file-backed and
// do not go through the per-file write serialization, so storing and reading within
// a single stdio session can race; two sessions against the same root are race-free.
async function seed(root: string, n: number, args: string[] = [], obsLen = 0): Promise<void> {
  const out = await driveServer(args, [INIT, INITIALIZED, storeMany(2, root, n, obsLen)], 2);
  const resp = out.find(m => m.id === 2);
  assert.ok(resp?.result, 'precondition: store must succeed');
}

test('read_all over stdio: limit returns only N entities and a [page] header with next offset', async () => {
  const root = tmpRoot();
  await seed(root, 5);
  const out = await driveServer(
    [],
    [
      INIT,
      INITIALIZED,
      call(3, 'aim_memory_read_all', { projectRoot: root, format: 'concise', offset: 0, limit: 2 }),
    ],
    3,
  );
  const resp = out.find(m => m.id === 3);
  assert.ok(resp?.result, 'expected a read_all result');
  const text: string = resp.result.content[0].text;
  assert.match(text, /\[page\] entities 0-2 of 5/);
  assert.match(text, /offset=2/);
  // Only the two paged entities appear in the concise entity list.
  assert.match(text, /- E0 \(t\)/);
  assert.match(text, /- E1 \(t\)/);
  assert.doesNotMatch(text, /- E2 \(t\)/);
});

test('read_all over stdio: --max-output-chars 連一頁都放不下時走硬切，且輸出絕不超限', async () => {
  // 測試前提更新（capText 修復後）：max=80 時自動分頁失敗（單頁 ~150 字元），
  // 而指引 notice 約 180 字元也放不下——capText 退回純硬切。此情境下能斷言的
  // 是硬上限保證本身：輸出絕不超過 80 字元。（附指引的路徑由 max=200 的
  // 單元測試覆蓋：「capText: truncates oversized text ... and appends guidance」。）
  const root = tmpRoot();
  await seed(root, 6);
  const out = await driveServer(
    ['--max-output-chars=80'],
    [INIT, INITIALIZED, call(3, 'aim_memory_read_all', { projectRoot: root, format: 'concise' })],
    3,
  );
  const resp = out.find(m => m.id === 3);
  assert.ok(resp?.result, 'expected a read_all result');
  const text: string = resp.result.content[0].text;
  assert.ok(text.length <= 80, `hard-capped length ${text.length} must be <= 80`);
  assert.ok(text.length > 0, '仍回傳前綴內容而非空字串');
});

test('read_all over stdio: oversized unpaginated output auto-paginates instead of truncating', async () => {
  const root = tmpRoot();
  // 60-char observations: concise page size is 155 + 71k chars for k entities,
  // so a 400-char cap fits exactly 3 entities per page.
  await seed(root, 6, [], 60);
  const out = await driveServer(
    ['--max-output-chars=400'],
    [INIT, INITIALIZED, call(3, 'aim_memory_read_all', { projectRoot: root, format: 'concise' })],
    3,
  );
  const resp = out.find(m => m.id === 3);
  assert.ok(resp?.result, 'expected a read_all result');
  const text: string = resp.result.content[0].text;
  assert.match(
    text,
    /^\[page\] entities 0-3 of 6 — more available: call read_all again with offset=3\n/,
  );
  assert.doesNotMatch(text, /truncated/);
  assert.ok(text.length <= 400, `auto-paged output ${text.length} must be <= 400`);
  assert.match(text, /- E0 \(t\)/);
  assert.match(text, /- E2 \(t\)/);
  assert.doesNotMatch(text, /- E3 \(t\)/);
});

test('read_all over stdio: an explicitly requested page that still exceeds the cap is hard-capped', async () => {
  const root = tmpRoot();
  await seed(root, 6, [], 60);
  const out = await driveServer(
    ['--max-output-chars=400'],
    [
      INIT,
      INITIALIZED,
      call(3, 'aim_memory_read_all', { projectRoot: root, format: 'concise', offset: 0, limit: 6 }),
    ],
    3,
  );
  const resp = out.find(m => m.id === 3);
  assert.ok(resp?.result, 'expected a read_all result');
  const text: string = resp.result.content[0].text;
  assert.match(text, /truncated/);
});
