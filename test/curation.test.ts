// Unit/integration tests for the curation & safety tools added on top of the
// base memory server. Each test uses a fresh temp directory as projectRoot (the
// multi-workspace path) and drives KnowledgeGraphManager directly. Coverage:
//   P0-1 updateEntity  - in-place rename/retype, relation endpoint rewrite, collisions
//   P0-2 replaceFact    - atomic delete-old/append-new, 0-match no-op, missing entity
//   P1-1 link validation- dangling endpoints rejected by default, allowDangling escape hatch
//   P1-2 doctor         - orphans / dangling / typeCollisions / duplicateCandidates / stats
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
