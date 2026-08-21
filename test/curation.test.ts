// Unit/integration tests for the curation & safety tools added on top of the
// base memory server. Each test uses a fresh temp directory as projectRoot (the
// multi-workspace path) and drives KnowledgeGraphManager directly. Coverage:
//   P0-1 updateEntity  - in-place rename/retype, relation endpoint rewrite, collisions
//   P0-2 replaceFact    - atomic delete-old/append-new, 0-match no-op, missing entity
//   P0-3 upsertKeyed    - opt-in same-key overwrite on addObservations
//   P1-1 link validation- dangling endpoints rejected by default, allowDangling escape hatch
//   P1-2 doctor         - orphans / dangling / typeCollisions / duplicateCandidates / stats
//   P1-3 doctor staleness- journalEntities (dated keys / journal drift) / unresolvedMarkers
//   P2-1 type governance- store warnings on near-duplicate entityType, listEntityTypes
//   P2-2 includeObservations- server-layer projection strips observations, keeps skeleton

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync } from 'node:fs';

import { KnowledgeGraphManager, type KnowledgeGraph } from '../storage.js';
import { projectObservations } from '../server.js';

function tmpRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'kg-curation-'));
}

// ---------------------------------------------------------------------------
// P0-1 updateEntity
// ---------------------------------------------------------------------------

test('updateEntity renames in place, preserving observations order and rewriting relations', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      { name: 'OldName', entityType: 'project', observations: ['first', 'second', 'third'] },
      { name: 'Acme', entityType: 'org', observations: [] },
    ],
    undefined,
    undefined,
    root,
  );
  await mgr.createRelations(
    [
      { from: 'OldName', to: 'Acme', relationType: 'owned_by' },
      { from: 'Acme', to: 'OldName', relationType: 'sponsors' },
    ],
    undefined,
    undefined,
    root,
  );

  const updated = await mgr.updateEntity(
    'OldName',
    { newName: 'NewName' },
    undefined,
    undefined,
    root,
  );
  assert.equal(updated.name, 'NewName');
  assert.deepEqual(
    updated.observations,
    ['first', 'second', 'third'],
    'observations preserved in order',
  );

  const graph = await mgr.readGraph(undefined, undefined, root);
  const names = graph.entities.map(e => e.name).sort();
  assert.deepEqual(names, ['Acme', 'NewName'], 'old name gone, new name present');
  // Every relation endpoint that pointed at the old name now points at the new name.
  assert.ok(graph.relations.every(r => r.from !== 'OldName' && r.to !== 'OldName'));
  assert.ok(graph.relations.some(r => r.from === 'NewName' && r.to === 'Acme'));
  assert.ok(graph.relations.some(r => r.from === 'Acme' && r.to === 'NewName'));

  // search hits the new name, misses the old.
  const hitNew = await mgr.searchNodes('NewName', undefined, undefined, root, { depth: 0 });
  assert.ok(hitNew.entities.some(e => e.name === 'NewName'));
  const hitOld = await mgr.searchNodes('OldName', undefined, undefined, root, { depth: 0 });
  assert.ok(!hitOld.entities.some(e => e.name === 'OldName'));
});

test('updateEntity can change entityType in place without touching observations', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [{ name: 'E', entityType: 'old_type', observations: ['keep'] }],
    undefined,
    undefined,
    root,
  );
  const updated = await mgr.updateEntity(
    'E',
    { entityType: 'new_type' },
    undefined,
    undefined,
    root,
  );
  assert.equal(updated.entityType, 'new_type');
  assert.deepEqual(updated.observations, ['keep']);
  const g = await mgr.readGraph(undefined, undefined, root);
  assert.equal(g.entities[0]!.entityType, 'new_type');
});

test('updateEntity rejects renaming onto an existing entity name (no overwrite)', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      { name: 'A', entityType: 't', observations: ['a'] },
      { name: 'B', entityType: 't', observations: ['b'] },
    ],
    undefined,
    undefined,
    root,
  );
  await assert.rejects(
    () => mgr.updateEntity('A', { newName: 'B' }, undefined, undefined, root),
    /already exists/,
  );
  // A and B are both intact.
  const g = await mgr.readGraph(undefined, undefined, root);
  assert.deepEqual(g.entities.map(e => e.name).sort(), ['A', 'B']);
  assert.deepEqual(g.entities.find(e => e.name === 'B')!.observations, ['b']);
});

test('updateEntity throws when the target entity does not exist', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await assert.rejects(
    () => mgr.updateEntity('Ghost', { entityType: 't' }, undefined, undefined, root),
    /not found/,
  );
});

test('updateEntity requires at least one of newName or entityType', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [{ name: 'E', entityType: 't', observations: [] }],
    undefined,
    undefined,
    root,
  );
  await assert.rejects(() => mgr.updateEntity('E', {}, undefined, undefined, root), /at least one/);
});

// ---------------------------------------------------------------------------
// P0-2 replaceFact
// ---------------------------------------------------------------------------

test('replaceFact replaces all prefix-matching observations with a single new text', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      {
        name: 'Plan',
        entityType: 'note',
        observations: [
          '開發計畫編號: v1',
          '開發計畫編號: v2',
          '開發計畫編號: v3',
          'unrelated fact',
        ],
      },
    ],
    undefined,
    undefined,
    root,
  );
  const res = await mgr.replaceFact(
    'Plan',
    { prefix: '開發計畫編號:' },
    '開發計畫編號: v4',
    undefined,
    undefined,
    root,
  );
  assert.deepEqual(res, { matched: 3, replaced: true });

  const g = await mgr.readGraph(undefined, undefined, root);
  const obs = g.entities[0]!.observations;
  assert.deepEqual(
    obs,
    ['unrelated fact', '開發計畫編號: v4'],
    'three old versions gone, one new appended, unrelated kept',
  );
});

test('replaceFact supports substring matching', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [{ name: 'E', entityType: 't', observations: ['status is red', 'status is amber', 'note'] }],
    undefined,
    undefined,
    root,
  );
  const res = await mgr.replaceFact(
    'E',
    { substring: 'status is' },
    'status is green',
    undefined,
    undefined,
    root,
  );
  assert.deepEqual(res, { matched: 2, replaced: true });
  const g = await mgr.readGraph(undefined, undefined, root);
  assert.deepEqual(g.entities[0]!.observations, ['note', 'status is green']);
});

test('replaceFact with 0 matches does not append and reports matched:0 (no silent no-op)', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [{ name: 'E', entityType: 't', observations: ['a', 'b'] }],
    undefined,
    undefined,
    root,
  );
  const res = await mgr.replaceFact('E', { prefix: 'nomatch:' }, 'new', undefined, undefined, root);
  assert.deepEqual(res, { matched: 0, replaced: false });
  const g = await mgr.readGraph(undefined, undefined, root);
  assert.deepEqual(g.entities[0]!.observations, ['a', 'b'], 'nothing appended on 0 match');
});

test('replaceFact throws when the entity does not exist', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await assert.rejects(
    () => mgr.replaceFact('Ghost', { prefix: 'x' }, 'y', undefined, undefined, root),
    /not found/,
  );
});

test('replaceFact requires exactly one of matchPrefix or matchSubstring', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [{ name: 'E', entityType: 't', observations: ['a'] }],
    undefined,
    undefined,
    root,
  );
  await assert.rejects(
    () => mgr.replaceFact('E', {}, 'y', undefined, undefined, root),
    /exactly one/,
  );
  await assert.rejects(
    () => mgr.replaceFact('E', { prefix: 'a', substring: 'b' }, 'y', undefined, undefined, root),
    /exactly one/,
  );
});

// ---------------------------------------------------------------------------
// P1-1 link endpoint validation
// ---------------------------------------------------------------------------

test('createRelations rejects dangling endpoints by default and does not write', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [{ name: 'A', entityType: 't', observations: [] }],
    undefined,
    undefined,
    root,
  );
  await assert.rejects(
    () =>
      mgr.createRelations(
        [{ from: 'A', to: 'Missing', relationType: 'r' }],
        undefined,
        undefined,
        root,
      ),
    /Missing/,
  );
  const g = await mgr.readGraph(undefined, undefined, root);
  assert.equal(g.relations.length, 0, 'no relation persisted when an endpoint is missing');
});

test('createRelations lists all missing endpoints in the error', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [{ name: 'A', entityType: 't', observations: [] }],
    undefined,
    undefined,
    root,
  );
  await assert.rejects(
    () =>
      mgr.createRelations([{ from: 'X', to: 'Y', relationType: 'r' }], undefined, undefined, root),
    (err: Error) => /X/.test(err.message) && /Y/.test(err.message),
  );
});

test('createRelations with allowDangling:true preserves legacy behavior', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [{ name: 'A', entityType: 't', observations: [] }],
    undefined,
    undefined,
    root,
  );
  const created = await mgr.createRelations(
    [{ from: 'A', to: 'Missing', relationType: 'r' }],
    undefined,
    undefined,
    root,
    true,
  );
  assert.equal(created.length, 1);
  const g = await mgr.readGraph(undefined, undefined, root);
  assert.equal(g.relations.length, 1, 'dangling relation persisted under the escape hatch');
});

// ---------------------------------------------------------------------------
// P1-2 doctor
// ---------------------------------------------------------------------------

test('doctor returns all-empty findings for a clean graph', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      { name: 'A', entityType: 'thing', observations: ['x: 1'] },
      { name: 'B', entityType: 'thing', observations: [] },
    ],
    undefined,
    undefined,
    root,
  );
  await mgr.createRelations(
    [{ from: 'A', to: 'B', relationType: 'r' }],
    undefined,
    undefined,
    root,
  );

  const report = await mgr.doctor(undefined, undefined, root);
  assert.deepEqual(report.orphans, []);
  assert.deepEqual(report.danglingRelations, []);
  assert.deepEqual(report.typeCollisions, []);
  assert.deepEqual(report.duplicateCandidates, []);
  assert.deepEqual(report.oversizedEntities, []);
  assert.deepEqual(report.journalEntities, []);
  assert.deepEqual(report.unresolvedMarkers, []);
  assert.equal(report.stats.entityCount, 2);
  assert.equal(report.stats.relationCount, 1);
  assert.equal(report.stats.observationCount, 1);
});

test('doctor detects orphans (entities with no relation)', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      { name: 'Lonely', entityType: 't', observations: [] },
      { name: 'A', entityType: 't', observations: [] },
      { name: 'B', entityType: 't', observations: [] },
    ],
    undefined,
    undefined,
    root,
  );
  await mgr.createRelations(
    [{ from: 'A', to: 'B', relationType: 'r' }],
    undefined,
    undefined,
    root,
  );
  const report = await mgr.doctor(undefined, undefined, root);
  assert.deepEqual(report.orphans, ['Lonely']);
});

test('doctor detects dangling relations (endpoint entity missing)', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  // Seed a dangling relation via the escape hatch so doctor has something to find.
  await mgr.createEntities(
    [{ name: 'A', entityType: 't', observations: [] }],
    undefined,
    undefined,
    root,
  );
  await mgr.createRelations(
    [{ from: 'A', to: 'Ghost', relationType: 'r' }],
    undefined,
    undefined,
    root,
    true,
  );
  const report = await mgr.doctor(undefined, undefined, root);
  assert.equal(report.danglingRelations.length, 1);
  assert.equal(report.danglingRelations[0]!.to, 'Ghost');
});

test('doctor detects entityType collisions differing only by case/underscore/hyphen', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      { name: 'a', entityType: 'dev-plan', observations: [] },
      { name: 'b', entityType: 'dev_plan', observations: [] },
      { name: 'c', entityType: 'DevPlan', observations: [] },
      { name: 'd', entityType: 'person', observations: [] },
    ],
    undefined,
    undefined,
    root,
  );
  const report = await mgr.doctor(undefined, undefined, root);
  assert.equal(
    report.typeCollisions.length,
    1,
    'the three dev-plan variants collapse to one collision group',
  );
  assert.deepEqual(report.typeCollisions[0]!.types.sort(), ['DevPlan', 'dev-plan', 'dev_plan']);
});

test('doctor detects duplicate-candidate observations sharing a key prefix', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      {
        name: 'Plan',
        entityType: 't',
        observations: ['開發計畫編號: v1', '開發計畫編號: v2', 'owner: alice'],
      },
    ],
    undefined,
    undefined,
    root,
  );
  const report = await mgr.doctor(undefined, undefined, root);
  assert.equal(report.duplicateCandidates.length, 1);
  assert.equal(report.duplicateCandidates[0]!.entityName, 'Plan');
  assert.equal(report.duplicateCandidates[0]!.keyPrefix, '開發計畫編號');
  assert.equal(report.duplicateCandidates[0]!.count, 2);
});

test('doctor flags entities at or above the observation-count threshold (50)', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      // 每條 'obs-NN' 長 6 字元：50 條共 300 字元，確保只觸發條數閾值、不觸發字元閾值。
      {
        name: 'Hub',
        entityType: 't',
        observations: Array.from({ length: 50 }, (_, i) => `obs-${String(i).padStart(2, '0')}`),
      },
      {
        name: 'Near',
        entityType: 't',
        observations: Array.from({ length: 49 }, (_, i) => `obs-${String(i).padStart(2, '0')}`),
      },
    ],
    undefined,
    undefined,
    root,
  );
  const report = await mgr.doctor(undefined, undefined, root);
  assert.equal(report.oversizedEntities.length, 1, '49 observations stays below the threshold');
  assert.equal(report.oversizedEntities[0]!.entityName, 'Hub');
  assert.equal(report.oversizedEntities[0]!.observationCount, 50);
  assert.equal(report.oversizedEntities[0]!.totalChars, 300);
  assert.deepEqual(report.oversizedEntities[0]!.exceeds, ['observationCount']);
});

test('doctor flags entities at or above the total-chars threshold (10000)', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      { name: 'Fat', entityType: 't', observations: ['x'.repeat(10000)] },
      { name: 'Slim', entityType: 't', observations: ['x'.repeat(9999)] },
    ],
    undefined,
    undefined,
    root,
  );
  const report = await mgr.doctor(undefined, undefined, root);
  assert.equal(report.oversizedEntities.length, 1, '9999 chars stays below the threshold');
  assert.equal(report.oversizedEntities[0]!.entityName, 'Fat');
  assert.equal(report.oversizedEntities[0]!.observationCount, 1);
  assert.equal(report.oversizedEntities[0]!.totalChars, 10000);
  assert.deepEqual(report.oversizedEntities[0]!.exceeds, ['totalChars']);
});

test('doctor reports both exceed reasons and sorts oversized entities by totalChars descending', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      // 50 條 × 300 字元 = 15000 字元：條數與字元雙雙達標。
      {
        name: 'BothHub',
        entityType: 't',
        observations: Array.from(
          { length: 50 },
          (_, i) => `${String(i).padStart(3, '0')}${'a'.repeat(297)}`,
        ),
      },
      { name: 'FatOnly', entityType: 't', observations: ['y'.repeat(12000)] },
      { name: 'Clean', entityType: 't', observations: ['ok'] },
    ],
    undefined,
    undefined,
    root,
  );
  const report = await mgr.doctor(undefined, undefined, root);
  assert.deepEqual(
    report.oversizedEntities.map(o => o.entityName),
    ['BothHub', 'FatOnly'],
    'sorted by totalChars descending; clean entity absent',
  );
  assert.equal(report.oversizedEntities[0]!.totalChars, 15000);
  assert.deepEqual(report.oversizedEntities[0]!.exceeds, ['observationCount', 'totalChars']);
  assert.equal(report.oversizedEntities[1]!.totalChars, 12000);
  assert.deepEqual(report.oversizedEntities[1]!.exceeds, ['totalChars']);
});

// ---------------------------------------------------------------------------
// P1-3 doctor staleness detection (journalEntities / unresolvedMarkers)
// ---------------------------------------------------------------------------

test('doctor groups journal-style keys that differ only by an embedded date', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      {
        name: 'Staging',
        entityType: 'Environment',
        observations: [
          'staging deploy (2026-08-12): api build A',
          'staging deploy (2026-08-20, first run): api build B',
          'staging deploy (2026-08-20, second run): api build C',
          'deploy procedure: pull then recreate',
        ],
      },
    ],
    undefined,
    undefined,
    root,
  );
  const report = await mgr.doctor(undefined, undefined, root);
  assert.equal(report.journalEntities.length, 1);
  const hit = report.journalEntities[0]!;
  assert.equal(hit.entityName, 'Staging');
  assert.equal(hit.datedKeys, 3, 'the dateless procedure key is not counted');
  assert.equal(hit.totalObservations, 4);
  assert.equal(hit.sameSlotGroups.length, 1, 'the three dated keys collapse to one slot');
  assert.equal(hit.sameSlotGroups[0]!.slot, 'staging deploy');
  assert.equal(hit.sameSlotGroups[0]!.count, 3);
  assert.equal(
    hit.sameSlotGroups[0]!.keyPrefixes.length,
    3,
    'each dated key is reported so it can be pruned by prefix',
  );
});

test('doctor flags an entity whose keys are mostly dated even when no two share a slot', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      {
        name: 'Env',
        entityType: 'Environment',
        observations: [
          '2026-08-14 first deploy: a',
          '2026-08-14 second deploy: b',
          '2026-08-15 rollback: c',
          '2026-08-17 hotfix: d',
          '2026-08-21 schema change: e',
        ],
      },
      {
        name: 'Sparse',
        entityType: 'Environment',
        observations: ['note (2026-08-14): a', 'other note (2026-08-15): b', 'host: example'],
      },
    ],
    undefined,
    undefined,
    root,
  );
  const report = await mgr.doctor(undefined, undefined, root);
  assert.deepEqual(
    report.journalEntities.map(j => j.entityName),
    ['Env'],
    'five distinct dated keys reach the threshold; two stay below it',
  );
  assert.equal(report.journalEntities[0]!.datedKeys, 5);
  assert.deepEqual(report.journalEntities[0]!.sameSlotGroups, [], 'no two keys share a slot');
});

test('doctor spares a long entity whose dated keys are a small fraction of it', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      {
        name: 'Review',
        entityType: 'Review',
        // 6 dated keys out of 40 observations (15%) - dates are incidental, not the structure.
        observations: [
          ...Array.from({ length: 6 }, (_, i) => `2026-08-${10 + i} finding ${i}: detail`),
          ...Array.from({ length: 34 }, (_, i) => `finding ${i}: detail`),
        ],
      },
    ],
    undefined,
    undefined,
    root,
  );
  const report = await mgr.doctor(undefined, undefined, root);
  assert.deepEqual(
    report.journalEntities,
    [],
    'the count threshold alone would fire here; the ratio gate keeps the report actionable',
  );
});

test('doctor groups bare-date keys under an empty slot', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      {
        name: 'Frontend',
        entityType: 'Component',
        observations: ['2026-08-14: shipped the picker', '2026-08-15: reworked the picker'],
      },
    ],
    undefined,
    undefined,
    root,
  );
  const report = await mgr.doctor(undefined, undefined, root);
  assert.equal(report.journalEntities.length, 1);
  const groups = report.journalEntities[0]!.sameSlotGroups;
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.slot, '', 'a key that is nothing but a date has no slot');
  assert.equal(groups[0]!.count, 2);
});

test('doctor never reports dateless repeated keys as journal keys', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      {
        name: 'Runbook',
        entityType: 'Runbook',
        observations: ['service: api', 'service: worker', 'service: web'],
      },
    ],
    undefined,
    undefined,
    root,
  );
  const report = await mgr.doctor(undefined, undefined, root);
  assert.deepEqual(
    report.journalEntities,
    [],
    'legitimately multi-valued keys must not be flagged as versions of one slot',
  );
  assert.equal(report.duplicateCandidates.length, 1, 'they remain a duplicateCandidates group');
});

test('doctor does not mistake a version number for a date in a key head', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      {
        name: 'Tooling',
        entityType: 'Workspace',
        // Six dot-separated keys, enough to clear both journal thresholds if any of
        // them were read as a date. "3000.4.25" is structurally identical to a
        // dot-separated date, which is why the pattern refuses the dot separator.
        observations: [
          'cli skill search path (v3000.4.25): a',
          'plugin support (v3000.4.25): b',
          'runtime baseline (v3000.4.25): c',
          'packaged runtime (v3000.4.25): d',
          'installer (v3000.4.25): e',
          'chart 2026.08.12 bump: f',
          'ratio 3/4 of the budget: g',
        ],
      },
    ],
    undefined,
    undefined,
    root,
  );
  const report = await mgr.doctor(undefined, undefined, root);
  assert.deepEqual(
    report.journalEntities,
    [],
    'only a four-digit-year date counts; version and ratio fragments must not',
  );
});

test('doctor exempts SessionLog entities from journal-key detection', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      {
        name: 'Work log',
        entityType: 'SessionLog',
        observations: [
          'session 2026-08-20T09:00:00+08:00｜did: a',
          'session 2026-08-21T09:00:00+08:00｜did: b',
        ],
      },
    ],
    undefined,
    undefined,
    root,
  );
  const report = await mgr.doctor(undefined, undefined, root);
  assert.deepEqual(report.journalEntities, [], 'a session log is a journal by design');
});

test('doctor exempts SessionLog entities from duplicateCandidates', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      {
        name: 'Work log',
        entityType: 'SessionLog',
        // Two blocks written in the same hour: the first ':' lands inside the ISO
        // timestamp, so they group under one key and are always a false positive.
        observations: [
          'session 2026-08-21T15:17:03+08:00｜did: a',
          'session 2026-08-21T15:41:32+08:00｜did: b',
        ],
      },
    ],
    undefined,
    undefined,
    root,
  );
  const report = await mgr.doctor(undefined, undefined, root);
  assert.deepEqual(
    report.duplicateCandidates,
    [],
    'same-hour blocks are distinct records, and echoing their full text drowns the report',
  );
});

test('doctor treats the full-width colon as a key separator', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [{ name: 'E', entityType: 't', observations: ['別名：first', '別名：second'] }],
    undefined,
    undefined,
    root,
  );
  const report = await mgr.doctor(undefined, undefined, root);
  assert.equal(report.duplicateCandidates.length, 1);
  assert.equal(report.duplicateCandidates[0]!.keyPrefix, '別名');
});

test('doctor surfaces observations carrying unresolved markers', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      {
        name: 'Rule',
        entityType: 'domain-rule',
        observations: [
          '待確認：whether the offset is global or per template',
          'offset granularity: a single global value',
          'rollout: TBD',
        ],
      },
      { name: 'Settled', entityType: 't', observations: ['storage: postgres'] },
    ],
    undefined,
    undefined,
    root,
  );
  const report = await mgr.doctor(undefined, undefined, root);
  assert.equal(report.unresolvedMarkers.length, 1, 'only the entity with markers is reported');
  assert.equal(report.unresolvedMarkers[0]!.entityName, 'Rule');
  assert.equal(report.unresolvedMarkers[0]!.count, 2);
  assert.deepEqual(report.unresolvedMarkers[0]!.markers, ['TBD', '待確認']);
});

test('doctor truncates unresolved-marker excerpts to keep the report small', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [{ name: 'Long', entityType: 't', observations: [`deploy: TBD ${'x'.repeat(500)}`] }],
    undefined,
    undefined,
    root,
  );
  const report = await mgr.doctor(undefined, undefined, root);
  const excerpt = report.unresolvedMarkers[0]!.excerpts[0]!;
  assert.ok(excerpt.length <= 121, `excerpt stays bounded, got ${excerpt.length}`);
  assert.ok(excerpt.endsWith('…'), 'truncation is visible');
});

// ---------------------------------------------------------------------------
// P0-3 addObservations upsertKeyed
// ---------------------------------------------------------------------------

test('addObservations with upsertKeyed replaces the same key instead of appending', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      {
        name: 'Env',
        entityType: 'Environment',
        observations: ['deploy procedure: push the image tag', 'owner: platform team'],
      },
    ],
    undefined,
    undefined,
    root,
  );
  const res = await mgr.addObservations(
    [
      {
        entityName: 'Env',
        contents: ['deploy procedure: pull then recreate'],
        upsertKeyed: true,
      },
    ],
    undefined,
    undefined,
    root,
  );
  assert.deepEqual(res[0]!.replacedObservations, ['deploy procedure: push the image tag']);
  const g = await mgr.readGraph(undefined, undefined, root);
  assert.deepEqual(g.entities[0]!.observations, [
    'owner: platform team',
    'deploy procedure: pull then recreate',
  ]);
});

test('addObservations stays append-only when upsertKeyed is absent', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [{ name: 'Env', entityType: 't', observations: ['deploy: old'] }],
    undefined,
    undefined,
    root,
  );
  const res = await mgr.addObservations(
    [{ entityName: 'Env', contents: ['deploy: new'] }],
    undefined,
    undefined,
    root,
  );
  assert.equal(res[0]!.replacedObservations, undefined, 'no replacement reported');
  const g = await mgr.readGraph(undefined, undefined, root);
  assert.deepEqual(g.entities[0]!.observations, ['deploy: old', 'deploy: new']);
});

test('upsertKeyed only touches the matching key and leaves unkeyed content appended', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      {
        name: 'Env',
        entityType: 't',
        observations: ['service: api', 'service: web', 'deploy: old'],
      },
    ],
    undefined,
    undefined,
    root,
  );
  await mgr.addObservations(
    [
      {
        entityName: 'Env',
        contents: ['deploy: new', 'a free-form note with no key'],
        upsertKeyed: true,
      },
    ],
    undefined,
    undefined,
    root,
  );
  const g = await mgr.readGraph(undefined, undefined, root);
  assert.deepEqual(g.entities[0]!.observations, [
    'service: api',
    'service: web',
    'deploy: new',
    'a free-form note with no key',
  ]);
});

test('upsertKeyed collapses several existing versions of one key into the new value', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [{ name: 'E', entityType: 't', observations: ['狀態：v1', '狀態：v2', 'other: keep'] }],
    undefined,
    undefined,
    root,
  );
  const res = await mgr.addObservations(
    [{ entityName: 'E', contents: ['狀態：v3'], upsertKeyed: true }],
    undefined,
    undefined,
    root,
  );
  assert.equal(res[0]!.replacedObservations!.length, 2);
  const g = await mgr.readGraph(undefined, undefined, root);
  assert.deepEqual(g.entities[0]!.observations, ['other: keep', '狀態：v3']);
});

test('upsertKeyed writing an identical line changes nothing and reports no replacement', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [{ name: 'E', entityType: 't', observations: ['deploy: same'] }],
    undefined,
    undefined,
    root,
  );
  const res = await mgr.addObservations(
    [{ entityName: 'E', contents: ['deploy: same'], upsertKeyed: true }],
    undefined,
    undefined,
    root,
  );
  assert.deepEqual(res[0]!.addedObservations, []);
  assert.deepEqual(res[0]!.replacedObservations, []);
  const g = await mgr.readGraph(undefined, undefined, root);
  assert.deepEqual(g.entities[0]!.observations, ['deploy: same']);
});

// ---------------------------------------------------------------------------
// P2-1 entityType governance
// ---------------------------------------------------------------------------

test('createEntities returns a warning when a new entityType only differs in format from an existing one', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [{ name: 'a', entityType: 'dev-plan', observations: [] }],
    undefined,
    undefined,
    root,
  );
  const res = await mgr.createEntities(
    [{ name: 'b', entityType: 'DevPlan', observations: [] }],
    undefined,
    undefined,
    root,
  );
  assert.equal(res.entities.length, 1, 'entity is still written (warning does not block)');
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0]!, /DevPlan/);
  assert.match(res.warnings[0]!, /dev-plan/);
});

test('createEntities emits no warning for a genuinely new entityType', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [{ name: 'a', entityType: 'dev-plan', observations: [] }],
    undefined,
    undefined,
    root,
  );
  const res = await mgr.createEntities(
    [{ name: 'b', entityType: 'person', observations: [] }],
    undefined,
    undefined,
    root,
  );
  assert.deepEqual(res.warnings, []);
});

test('listEntityTypes returns each entityType with its entity count, most frequent first', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [
      { name: 'a', entityType: 'person', observations: [] },
      { name: 'b', entityType: 'person', observations: [] },
      { name: 'c', entityType: 'org', observations: [] },
    ],
    undefined,
    undefined,
    root,
  );
  const types = await mgr.listEntityTypes(undefined, undefined, root);
  assert.deepEqual(types, [
    { entityType: 'person', count: 2 },
    { entityType: 'org', count: 1 },
  ]);
});

// ---------------------------------------------------------------------------
// P2-2 includeObservations projection (server layer)
// ---------------------------------------------------------------------------

const sampleGraph = (): KnowledgeGraph => ({
  entities: [
    { name: 'A', entityType: 'thing', observations: ['obs one', 'obs two'] },
    { name: 'B', entityType: 'other', observations: ['obs three'] },
  ],
  relations: [{ from: 'A', to: 'B', relationType: 'r' }],
});

test('projectObservations with includeObservations:false strips observations but keeps the relation skeleton', () => {
  const out = projectObservations(sampleGraph(), false);
  assert.deepEqual(
    out.entities.map(e => ({ name: e.name, entityType: e.entityType })),
    [
      { name: 'A', entityType: 'thing' },
      { name: 'B', entityType: 'other' },
    ],
  );
  assert.ok(
    out.entities.every(e => e.observations.length === 0),
    'all observations stripped',
  );
  assert.deepEqual(
    out.relations,
    [{ from: 'A', to: 'B', relationType: 'r' }],
    'relations preserved as skeleton',
  );
});

test('projectObservations defaults to including observations (undefined and true are pass-through)', () => {
  const g1 = sampleGraph();
  assert.equal(projectObservations(g1, undefined), g1, 'undefined returns the graph unchanged');
  const g2 = sampleGraph();
  assert.equal(projectObservations(g2, true), g2, 'true returns the graph unchanged');
  assert.deepEqual(projectObservations(sampleGraph(), undefined).entities[0]!.observations, [
    'obs one',
    'obs two',
  ]);
});
