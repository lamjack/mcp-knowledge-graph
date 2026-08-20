// Observation 級操作測試：消滅刪除靜默失敗、補上 observation 級過濾與分組計數。
// 動機：SessionLog prune 流程需要「刪掉某前綴的全部 observation」與「數出 entity 內
// 某前綴有幾個分組」，且每個刪除操作必須能從回傳分辨實際刪除數量（0 命中明確可辨），
// 不再繞過 MCP 直讀底層 jsonl。涵蓋：
//   1. deleteObservations 結構化回報 - per-entity {entityExists, requested, removed, unmatched}
//   2. deleteObservations 前綴模式   - entry 級 observationPrefix（與 observations 恰一）
//   3. countObservations             - 唯讀前綴計數 + groupByDelimiter 分組（不回本文）
//   4. filterObservations（server 層）- get 的 observationPrefix/observationSubstring 過濾
//   5. stdio 整合                    - remove_facts 結構化回傳、get 過濾、count_observations、
//                                      大 entity 過濾不截斷、刪除→計數的寫後核實閉環

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { statSync, utimesSync } from 'node:fs';

import { KnowledgeGraphManager, type KnowledgeGraph } from '../storage.js';
import { filterObservations } from '../server.js';
import { INIT, INITIALIZED, call, driveServer, tmpRoot as makeTmpRoot } from './helpers.js';

function tmpRoot(): string {
  return makeTmpRoot('kg-obsops-');
}

// 模擬真實 SessionLog prune 場景的資料：兩個 session 區塊 + 一條持久事實。
const TS_A = 'session 2026-08-01T10:00:00+08:00｜';
const TS_B = 'session 2026-08-02T11:30:00+08:00｜';
const SESSION_OBS = [
  `${TS_A}investigated: 查了時區設定`,
  `${TS_A}did: 修了 deleteObservations`,
  `${TS_A}pending: 還要補測試`,
  `${TS_B}investigated: 只看了一眼`,
];

async function seedSessionLog(mgr: KnowledgeGraphManager, root: string): Promise<void> {
  await mgr.createEntities(
    [
      { name: 'Log', entityType: 'SessionLog', observations: [...SESSION_OBS, 'durable 持久事實'] },
      { name: 'Other', entityType: 't', observations: ['session 無前綴分隔符的條目'] },
    ],
    undefined,
    undefined,
    root,
  );
}

// ---------------------------------------------------------------------------
// 1. deleteObservations 結構化回報（exact 模式，向後相容）
// ---------------------------------------------------------------------------

test('deleteObservations exact 模式回傳 per-entity 結構化報告（部分命中列出 unmatched）', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await seedSessionLog(mgr, root);

  const res = await mgr.deleteObservations(
    [
      {
        entityName: 'Log',
        observations: [`${TS_A}did: 修了 deleteObservations`, '不存在的條目'],
      },
    ],
    undefined,
    undefined,
    root,
  );

  assert.deepEqual(res, [
    {
      entityName: 'Log',
      entityExists: true,
      requested: 2,
      removed: 1,
      unmatched: ['不存在的條目'],
    },
  ]);

  const g = await mgr.readGraph(undefined, undefined, root);
  const obs = g.entities.find(e => e.name === 'Log')!.observations;
  assert.ok(!obs.includes(`${TS_A}did: 修了 deleteObservations`), '命中者已刪');
  assert.equal(obs.length, 4, '其餘 observation 保留');
});

test('deleteObservations exact 模式 0 命中：removed:0、unmatched 全列、圖譜不變', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await seedSessionLog(mgr, root);

  const res = await mgr.deleteObservations(
    [{ entityName: 'Log', observations: ['甲', '乙'] }],
    undefined,
    undefined,
    root,
  );
  assert.deepEqual(res, [
    { entityName: 'Log', entityExists: true, requested: 2, removed: 0, unmatched: ['甲', '乙'] },
  ]);
  const g = await mgr.readGraph(undefined, undefined, root);
  assert.equal(g.entities.find(e => e.name === 'Log')!.observations.length, 5, '未刪任何條目');
});

test('deleteObservations 0 刪除時不寫檔（不觸碰 mtime，比照 replaceFact 紀律）', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await seedSessionLog(mgr, root);

  // 把記憶檔 mtime 釘到過去：若發生寫入，mtime 會變成現在。
  const file = path.join(root, '.aim', 'memory.jsonl');
  const past = new Date('2020-01-01T00:00:00Z');
  utimesSync(file, past, past);

  await mgr.deleteObservations(
    [{ entityName: 'Log', observations: ['不存在'] }],
    undefined,
    undefined,
    root,
  );
  assert.equal(
    statSync(file).mtimeMs,
    past.getTime(),
    '0 刪除不得觸碰記憶檔（無謂的 mtime 變動會讓快取失效）',
  );
});

test('deleteObservations exact 模式對長 CJK 字串逐字比對：一模一樣才刪，差一字不刪', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  const longCjk = `設定說明：${'這是一段很長的中文觀察內容，用來驗證長字串比對。'.repeat(10)}`;
  await mgr.createEntities(
    [{ name: 'E', entityType: 't', observations: [longCjk, 'short'] }],
    undefined,
    undefined,
    root,
  );

  // 差一個字（結尾「。」換成「！」）→ 不得刪除，且必須出現在 unmatched。
  const nearMiss = await mgr.deleteObservations(
    [{ entityName: 'E', observations: [longCjk.slice(0, -1) + '！'] }],
    undefined,
    undefined,
    root,
  );
  assert.equal(nearMiss[0]!.removed, 0);
  assert.equal(nearMiss[0]!.unmatched.length, 1);

  // 一模一樣 → 刪除成功。
  const exact = await mgr.deleteObservations(
    [{ entityName: 'E', observations: [longCjk] }],
    undefined,
    undefined,
    root,
  );
  assert.deepEqual(exact, [
    { entityName: 'E', entityExists: true, requested: 1, removed: 1, unmatched: [] },
  ]);
  const g = await mgr.readGraph(undefined, undefined, root);
  assert.deepEqual(g.entities[0]!.observations, ['short']);
});

// ---------------------------------------------------------------------------
// 2. deleteObservations 前綴模式
// ---------------------------------------------------------------------------

test('deleteObservations 前綴模式刪除該前綴的全部 observation（prune 的自然表達）', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await seedSessionLog(mgr, root);

  const res = await mgr.deleteObservations(
    [{ entityName: 'Log', observationPrefix: TS_A }],
    undefined,
    undefined,
    root,
  );
  assert.deepEqual(res, [
    { entityName: 'Log', entityExists: true, requested: 1, removed: 3, unmatched: [] },
  ]);

  const g = await mgr.readGraph(undefined, undefined, root);
  const obs = g.entities.find(e => e.name === 'Log')!.observations;
  assert.deepEqual(obs, [`${TS_B}investigated: 只看了一眼`, 'durable 持久事實']);
});

test('deleteObservations 前綴模式 0 命中：removed:0 且 unmatched 回顯前綴（可分辨「打錯前綴」）', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await seedSessionLog(mgr, root);

  const res = await mgr.deleteObservations(
    [{ entityName: 'Log', observationPrefix: 'session 1999-01-01' }],
    undefined,
    undefined,
    root,
  );
  assert.deepEqual(res, [
    {
      entityName: 'Log',
      entityExists: true,
      requested: 1,
      removed: 0,
      unmatched: ['session 1999-01-01'],
    },
  ]);
});

test('deleteObservations entity 不存在：如實回報不丟錯，同批其他 entity 照常執行', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await seedSessionLog(mgr, root);

  const res = await mgr.deleteObservations(
    [
      { entityName: 'Ghost', observations: ['a', 'b'] },
      { entityName: 'Log', observationPrefix: TS_B },
    ],
    undefined,
    undefined,
    root,
  );
  assert.deepEqual(res, [
    { entityName: 'Ghost', entityExists: false, requested: 2, removed: 0, unmatched: ['a', 'b'] },
    { entityName: 'Log', entityExists: true, requested: 1, removed: 1, unmatched: [] },
  ]);

  const g = await mgr.readGraph(undefined, undefined, root);
  assert.equal(g.entities.find(e => e.name === 'Log')!.observations.length, 4, 'Log 仍被處理');
});

test('deleteObservations 每個 entry 必須恰給 observations 或 observationPrefix 之一（非空）', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await seedSessionLog(mgr, root);

  await assert.rejects(
    () =>
      mgr.deleteObservations(
        [{ entityName: 'Log', observations: ['a'], observationPrefix: 'session' }],
        undefined,
        undefined,
        root,
      ),
    /exactly one/,
  );
  await assert.rejects(
    () => mgr.deleteObservations([{ entityName: 'Log' }], undefined, undefined, root),
    /exactly one/,
  );
  await assert.rejects(
    () =>
      mgr.deleteObservations([{ entityName: 'Log', observations: [] }], undefined, undefined, root),
    /exactly one/,
  );
  await assert.rejects(
    () =>
      mgr.deleteObservations(
        [{ entityName: 'Log', observationPrefix: '' }],
        undefined,
        undefined,
        root,
      ),
    /exactly one/,
  );
});

// ---------------------------------------------------------------------------
// 3. countObservations（唯讀前綴計數 + 分組）
// ---------------------------------------------------------------------------

test('countObservations 回傳每個 entity 的前綴命中數與 observation 總數（不回本文）', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await seedSessionLog(mgr, root);

  const res = await mgr.countObservations(
    ['Log'],
    'session ',
    undefined,
    undefined,
    undefined,
    root,
  );
  assert.deepEqual(res, [
    { entityName: 'Log', entityExists: true, totalObservations: 5, matched: 4, groups: undefined },
  ]);
});

test('countObservations 以 groupByDelimiter 分組：key 為開頭到首個分隔符（含）', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await seedSessionLog(mgr, root);

  const res = await mgr.countObservations(['Log'], 'session ', '｜', undefined, undefined, root);
  assert.equal(res[0]!.matched, 4);
  assert.deepEqual(res[0]!.groups, [
    { key: TS_A, count: 3 },
    { key: TS_B, count: 1 },
  ]);
});

test('countObservations 命中條目不含分隔符時以全文為 key；entity 不存在如實回報', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await seedSessionLog(mgr, root);

  const res = await mgr.countObservations(
    ['Other', 'Ghost'],
    'session ',
    '｜',
    undefined,
    undefined,
    root,
  );
  assert.deepEqual(res, [
    {
      entityName: 'Other',
      entityExists: true,
      totalObservations: 1,
      matched: 1,
      groups: [{ key: 'session 無前綴分隔符的條目', count: 1 }],
    },
    { entityName: 'Ghost', entityExists: false, totalObservations: 0, matched: 0, groups: [] },
  ]);
});

test('countObservations 的 observationPrefix 必填非空', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await seedSessionLog(mgr, root);
  await assert.rejects(
    () => mgr.countObservations(['Log'], '', undefined, undefined, undefined, root),
    /observationPrefix/,
  );
});

// ---------------------------------------------------------------------------
// 4. filterObservations（server 層，aim_memory_get 的 observation 過濾）
// ---------------------------------------------------------------------------

const filterGraph = (): KnowledgeGraph => ({
  entities: [
    { name: 'Log', entityType: 'SessionLog', observations: [...SESSION_OBS, 'durable 持久事實'] },
    { name: 'Empty', entityType: 't', observations: ['無關條目'] },
  ],
  relations: [{ from: 'Log', to: 'Empty', relationType: 'r' }],
});

test('filterObservations 前綴過濾只留命中條目，抬頭報命中/總數；0 命中 entity 保留空 observations', () => {
  const { graph, header } = filterObservations(filterGraph(), 'session ', undefined);
  assert.ok(header, '過濾啟動時必須有抬頭');
  assert.match(header!, /prefix="session "/);
  assert.match(header!, /matched 4 of 6 observations/);
  assert.match(header!, /1 of 2 entities/);

  const log = graph.entities.find(e => e.name === 'Log')!;
  assert.deepEqual(log.observations, SESSION_OBS, '只剩前綴命中條目');
  const empty = graph.entities.find(e => e.name === 'Empty')!;
  assert.deepEqual(
    empty.observations,
    [],
    '0 命中 entity 保留（空 observations），可與「entity 消失」分辨',
  );
  assert.equal(graph.relations.length, 1, '關係骨架保留');
});

test('filterObservations substring 過濾與前綴等價可用', () => {
  const { graph, header } = filterObservations(filterGraph(), undefined, 'pending');
  assert.match(header!, /substring="pending"/);
  assert.match(header!, /matched 1 of 6 observations/);
  assert.deepEqual(graph.entities[0]!.observations, [`${TS_A}pending: 還要補測試`]);
});

test('filterObservations 不帶過濾參數時原樣透傳（向後相容，同參考無拷貝）', () => {
  const g = filterGraph();
  const { graph, header } = filterObservations(g, undefined, undefined);
  assert.equal(header, null);
  assert.equal(graph, g, '未啟動過濾時回傳同一參考，行為逐位元組不變');
});

test('filterObservations 同時給 prefix 與 substring 報錯（恰擇一）', () => {
  assert.throws(() => filterObservations(filterGraph(), 'a', 'b'), /at most one/);
});

// ---------------------------------------------------------------------------
// 5. stdio 整合
// ---------------------------------------------------------------------------

// 驅動碼集中於 ./helpers.js（與 pagination / tool-errors 共用）。
// 注意：寫入與讀取分開 session 避免競態（讀取不走 write chain）。

async function seedStdio(root: string): Promise<void> {
  const out = await driveServer(
    ['--workspace-only'],
    [
      INIT,
      INITIALIZED,
      call(2, 'aim_memory_store', {
        projectRoot: root,
        entities: [
          {
            name: 'Log',
            entityType: 'SessionLog',
            observations: [...SESSION_OBS, 'durable 持久事實'],
          },
        ],
      }),
    ],
    2,
  );
  assert.ok(out.find(m => m.id === 2)?.result, 'precondition: store must succeed');
}

test('stdio: remove_facts 回傳 per-entity 結構化 JSON（可分辨實際刪除數）', async () => {
  const root = tmpRoot();
  await seedStdio(root);

  const out = await driveServer(
    ['--workspace-only'],
    [
      INIT,
      INITIALIZED,
      call(2, 'aim_memory_remove_facts', {
        projectRoot: root,
        deletions: [
          { entityName: 'Log', observations: [`${TS_A}did: 修了 deleteObservations`, '不存在'] },
        ],
      }),
    ],
    2,
  );
  const resp = out.find(m => m.id === 2);
  assert.ok(resp?.result && !resp.result.isError, 'remove_facts 必須成功');
  const report = JSON.parse(resp.result.content[0].text);
  assert.deepEqual(report, [
    {
      entityName: 'Log',
      entityExists: true,
      requested: 2,
      removed: 1,
      unmatched: ['不存在'],
    },
  ]);
});

test('stdio: remove_facts 前綴刪除 → count_observations 核實歸零（寫後核實閉環，免直讀 jsonl）', async () => {
  const root = tmpRoot();
  await seedStdio(root);

  // session 2：前綴刪除整個 TS_A 區塊。
  const delOut = await driveServer(
    ['--workspace-only'],
    [
      INIT,
      INITIALIZED,
      call(2, 'aim_memory_remove_facts', {
        projectRoot: root,
        deletions: [{ entityName: 'Log', observationPrefix: TS_A }],
      }),
    ],
    2,
  );
  const del = delOut.find(m => m.id === 2);
  assert.ok(del?.result && !del.result.isError, '前綴刪除必須成功');
  const report = JSON.parse(del.result.content[0].text);
  assert.equal(report[0].removed, 3, '回傳必須指出實際刪了 3 條');

  // session 3：count_observations 核實落盤狀態（不回 observation 本文）。
  const countOut = await driveServer(
    ['--workspace-only'],
    [
      INIT,
      INITIALIZED,
      call(2, 'aim_memory_count_observations', {
        projectRoot: root,
        names: ['Log'],
        observationPrefix: 'session ',
        groupByDelimiter: '｜',
      }),
    ],
    2,
  );
  const counted = countOut.find(m => m.id === 2);
  assert.ok(counted?.result && !counted.result.isError, 'count_observations 必須成功');
  const stats = JSON.parse(counted.result.content[0].text);
  assert.equal(stats[0].totalObservations, 2, '總數反映刪後狀態');
  assert.equal(stats[0].matched, 1, 'TS_A 區塊已清空，只剩 TS_B 一條');
  assert.deepEqual(stats[0].groups, [{ key: TS_B, count: 1 }], '分組只剩 TS_B 區塊');
});

test('stdio: get 帶 observationPrefix 只回命中條目並附 [obs-filter] 抬頭', async () => {
  const root = tmpRoot();
  await seedStdio(root);

  const out = await driveServer(
    ['--workspace-only'],
    [
      INIT,
      INITIALIZED,
      call(2, 'aim_memory_get', {
        projectRoot: root,
        names: ['Log'],
        observationPrefix: TS_B,
      }),
    ],
    2,
  );
  const resp = out.find(m => m.id === 2);
  assert.ok(resp?.result && !resp.result.isError, 'get 必須成功');
  const text: string = resp.result.content[0].text;
  assert.match(
    text,
    /^\[obs-filter\] prefix="session 2026-08-02T11:30:00\+08:00｜": matched 1 of 5 observations across 1 of 1 entities\n/,
  );
  const payload = JSON.parse(text.slice(text.indexOf('\n') + 1));
  assert.deepEqual(payload.entities[0].observations, [`${TS_B}investigated: 只看了一眼`]);
});

test('stdio: 大 entity 過濾後輸出不截斷（過濾把超大 payload 縮小於上限內）', async () => {
  const root = tmpRoot();
  // 一個 entity 帶一條 3000 字 CJK 大 observation + 兩條短 session 條目；
  // 上限 800 遠小於全量，但過濾後的命中子集放得下。
  const seedOut = await driveServer(
    ['--workspace-only'],
    [
      INIT,
      INITIALIZED,
      call(2, 'aim_memory_store', {
        projectRoot: root,
        entities: [
          {
            name: 'Big',
            entityType: 't',
            observations: [
              `巨大內容：${'長'.repeat(3000)}`,
              `${TS_A}investigated: 短條目一`,
              `${TS_A}did: 短條目二`,
            ],
          },
        ],
      }),
    ],
    2,
  );
  assert.ok(seedOut.find(m => m.id === 2)?.result, 'precondition: store must succeed');

  const out = await driveServer(
    ['--workspace-only', '--max-output-chars=800'],
    [
      INIT,
      INITIALIZED,
      call(2, 'aim_memory_get', { projectRoot: root, names: ['Big'], observationPrefix: TS_A }),
    ],
    2,
  );
  const resp = out.find(m => m.id === 2);
  assert.ok(resp?.result && !resp.result.isError, 'get 必須成功');
  const text: string = resp.result.content[0].text;
  assert.ok(text.length <= 800, `過濾後輸出 ${text.length} 必須 <= 800`);
  assert.doesNotMatch(text, /truncated/, '過濾後不得觸發硬截斷');
  assert.match(text, /短條目一/);
  assert.match(text, /短條目二/);
  assert.doesNotMatch(text, /巨大內容/, '非命中的大 observation 不得出現');
});
