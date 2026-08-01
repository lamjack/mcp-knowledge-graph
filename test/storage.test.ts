// Integration tests for the storage layer: round-trip persistence via an
// explicit projectRoot (the multi-workspace path), atomic file creation with
// the _aim marker, and the safety guard against overwriting unrelated files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync, statSync, utimesSync } from 'node:fs';

import { KnowledgeGraphManager } from '../storage.js';
import { FILE_MARKER } from '../config.js';

function tmpRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'kg-store-'));
}

test('createEntities writes <projectRoot>/.aim/memory.jsonl with the _aim marker', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();

  const created = await mgr.createEntities(
    [{ name: 'Alice', entityType: 'person', observations: ['likes tea'] }],
    undefined,
    undefined,
    root,
  );
  assert.equal(created.length, 1);

  const file = path.join(root, '.aim', 'memory.jsonl');
  assert.ok(existsSync(file), 'expected memory.jsonl to be created');

  const firstLine = readFileSync(file, 'utf-8').split('\n')[0]!;
  const marker = JSON.parse(firstLine);
  assert.equal(marker.type, '_aim');
  assert.equal(marker.source, 'mcp-knowledge-graph');
});

test('store then read round-trips entities and relations', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();

  await mgr.createEntities(
    [
      { name: 'Alice', entityType: 'person', observations: ['likes tea'] },
      { name: 'Acme', entityType: 'org', observations: [] },
    ],
    undefined,
    undefined,
    root,
  );
  await mgr.createRelations(
    [{ from: 'Alice', to: 'Acme', relationType: 'works_at' }],
    undefined,
    undefined,
    root,
  );
  await mgr.addObservations(
    [{ entityName: 'Alice', contents: ['lives in Macau'] }],
    undefined,
    undefined,
    root,
  );

  const graph = await mgr.readGraph(undefined, undefined, root);
  assert.equal(graph.entities.length, 2);
  assert.equal(graph.relations.length, 1);
  const alice = graph.entities.find(e => e.name === 'Alice');
  assert.ok(alice);
  assert.deepEqual(alice!.observations, ['likes tea', 'lives in Macau']);
  assert.equal(graph.relations[0]!.relationType, 'works_at');
});

test('a named context is stored in a separate suffixed file', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();

  await mgr.createEntities(
    [{ name: 'Task', entityType: 'todo', observations: [] }],
    'work',
    undefined,
    root,
  );

  assert.ok(existsSync(path.join(root, '.aim', 'memory-work.jsonl')));
  // Master database must remain untouched.
  assert.ok(!existsSync(path.join(root, '.aim', 'memory.jsonl')));
});

test('refuses to read/overwrite a pre-existing file without the _aim marker', async () => {
  const root = tmpRoot();
  const aimDir = path.join(root, '.aim');
  mkdirSync(aimDir, { recursive: true });
  writeFileSync(path.join(aimDir, 'memory.jsonl'), '{"type":"entity","name":"X","entityType":"t","observations":[]}');

  const mgr = new KnowledgeGraphManager();
  await assert.rejects(
    () => mgr.createEntities([{ name: 'Y', entityType: 't', observations: [] }], undefined, undefined, root),
    /_aim safety marker/,
  );
});

// Regression guards for the read cache: caching is a performance optimization and
// must never serve stale data nor leak a shared mutable graph to callers.

test('read cache does not serve stale data after the file changes on disk', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();

  await mgr.createEntities(
    [{ name: 'Alice', entityType: 'person', observations: ['likes tea', 'lives in Macau'] }],
    undefined,
    undefined,
    root,
  );
  // Prime any cache.
  const first = await mgr.readGraph(undefined, undefined, root);
  assert.equal(first.entities[0]!.name, 'Alice');

  // Replace the file out-of-band with a clearly different size/content.
  const file = path.join(root, '.aim', 'memory.jsonl');
  writeFileSync(file, [JSON.stringify(FILE_MARKER), JSON.stringify({ type: 'entity', name: 'Zed', entityType: 'x', observations: [] })].join('\n'));

  const second = await mgr.readGraph(undefined, undefined, root);
  assert.equal(second.entities.length, 1);
  assert.equal(second.entities[0]!.name, 'Zed', 'external change must be observed, not a cached Alice');
});

test('reads return an isolated copy that callers cannot use to mutate stored state', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();

  await mgr.createEntities(
    [{ name: 'Alice', entityType: 'person', observations: ['a'] }],
    undefined,
    undefined,
    root,
  );

  const g1 = await mgr.readGraph(undefined, undefined, root);
  g1.entities[0]!.observations.push('MUTATED');
  g1.entities.push({ name: 'Injected', entityType: 't', observations: [] });

  const g2 = await mgr.readGraph(undefined, undefined, root);
  assert.equal(g2.entities.length, 1, 'caller mutation must not leak into subsequent reads');
  assert.deepEqual(g2.entities[0]!.observations, ['a']);
});

test('read cache serves the cached copy when mtime and size are unchanged (proves reads hit the cache)', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [{ name: 'Alice', entityType: 'person', observations: ['likes tea'] }],
    undefined,
    undefined,
    root,
  );
  const file = path.join(root, '.aim', 'memory.jsonl');

  // Pin an exact integer-millisecond mtime so it round-trips precisely through Date/utimes,
  // then re-read so the cache records that pinned stamp.
  const pinned = new Date(1_000_000_000_000);
  utimesSync(file, pinned, pinned);
  const primed = await mgr.readGraph(undefined, undefined, root);
  assert.equal(primed.entities[0]!.name, 'Alice');

  // Corrupt the file with SAME-length bytes lacking the _aim marker, then restore the pinned mtime.
  const size = statSync(file).size;
  writeFileSync(file, 'x'.repeat(size));
  utimesSync(file, pinned, pinned);
  assert.equal(statSync(file).size, size, 'precondition: byte length is unchanged');

  // A cache hit must return the cached graph WITHOUT reading the corrupted bytes (would otherwise
  // throw on the missing marker). This proves the read path is actually served from cache.
  const served = await mgr.readGraph(undefined, undefined, root);
  assert.equal(served.entities.length, 1);
  assert.equal(served.entities[0]!.name, 'Alice');
});

// Characterization + isolation guards for the algorithmic refactor (Set/Map dedup,
// adjacency BFS, result-granularity cloning). They pin current behaviour so the
// refactor cannot change results, and would go red if a read path leaked a shared
// reference into the cache.

test('createEntities ignores names that already exist (dedup, existing untouched)', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities([{ name: 'A', entityType: 't', observations: ['x'] }], undefined, undefined, root);
  const created = await mgr.createEntities(
    [
      { name: 'A', entityType: 't', observations: ['SHOULD NOT OVERWRITE'] },
      { name: 'B', entityType: 't', observations: [] },
    ],
    undefined,
    undefined,
    root,
  );
  assert.deepEqual(created.map(e => e.name), ['B'], 'only the genuinely new entity is returned');
  const g = await mgr.readGraph(undefined, undefined, root);
  assert.equal(g.entities.length, 2);
  assert.deepEqual(g.entities.find(e => e.name === 'A')!.observations, ['x'], 'existing entity left untouched');
});

test('createRelations ignores duplicate relations', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities([{ name: 'A', entityType: 't', observations: [] }, { name: 'B', entityType: 't', observations: [] }], undefined, undefined, root);
  await mgr.createRelations([{ from: 'A', to: 'B', relationType: 'r' }], undefined, undefined, root);
  const created = await mgr.createRelations(
    [
      { from: 'A', to: 'B', relationType: 'r' },     // duplicate
      { from: 'A', to: 'B', relationType: 'other' }, // new
    ],
    undefined,
    undefined,
    root,
  );
  assert.deepEqual(created.map(r => r.relationType), ['other']);
  const g = await mgr.readGraph(undefined, undefined, root);
  assert.equal(g.relations.length, 2);
});

test('deleteEntities also removes every relation touching the deleted entity', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities([{ name: 'A', entityType: 't', observations: [] }, { name: 'B', entityType: 't', observations: [] }, { name: 'C', entityType: 't', observations: [] }], undefined, undefined, root);
  await mgr.createRelations([{ from: 'A', to: 'B', relationType: 'r' }, { from: 'B', to: 'C', relationType: 'r' }], undefined, undefined, root);
  await mgr.deleteEntities(['B'], undefined, undefined, root);
  const g = await mgr.readGraph(undefined, undefined, root);
  assert.deepEqual(g.entities.map(e => e.name).sort(), ['A', 'C']);
  assert.equal(g.relations.length, 0, 'both relations touched B and must be gone');
});

test('search results are a copy isolated from stored/cached state', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities([{ name: 'Needle', entityType: 't', observations: ['a'] }], undefined, undefined, root);

  const r1 = await mgr.searchNodes('needle', undefined, undefined, root);
  assert.equal(r1.entities.length, 1);
  r1.entities[0]!.observations.push('MUTATED');

  const r2 = await mgr.searchNodes('needle', undefined, undefined, root);
  assert.deepEqual(r2.entities[0]!.observations, ['a'], 'mutating a search result must not affect stored data');
});

test('openNodes returns requested entities + interconnecting relations, isolated from cache', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities([{ name: 'A', entityType: 't', observations: ['a'] }, { name: 'B', entityType: 't', observations: [] }, { name: 'C', entityType: 't', observations: [] }], undefined, undefined, root);
  await mgr.createRelations([{ from: 'A', to: 'B', relationType: 'r' }, { from: 'A', to: 'C', relationType: 'r' }], undefined, undefined, root);

  const r1 = await mgr.openNodes(['A', 'B'], undefined, undefined, root);
  assert.deepEqual(r1.entities.map(e => e.name).sort(), ['A', 'B']);
  assert.equal(r1.relations.length, 1, 'only relations with both endpoints in the requested set are kept');
  assert.equal(r1.relations[0]!.to, 'B');

  r1.entities[0]!.observations.push('MUTATED');
  const r2 = await mgr.openNodes(['A'], undefined, undefined, root);
  assert.deepEqual(r2.entities[0]!.observations, ['a'], 'mutating an openNodes result must not corrupt the cache');
});

test('read cache invalidates on a same-size content change (mtime, not just size, drives invalidation)', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager();
  await mgr.createEntities(
    [{ name: 'Alice', entityType: 'person', observations: ['likes tea'] }],
    undefined,
    undefined,
    root,
  );
  const file = path.join(root, '.aim', 'memory.jsonl');

  const pinned = new Date(1_000_000_000_000);
  utimesSync(file, pinned, pinned);
  const primed = await mgr.readGraph(undefined, undefined, root);
  assert.equal(primed.entities[0]!.name, 'Alice');
  const targetLen = statSync(file).size;

  // Build a valid replacement graph padded to the EXACT same byte length, so only mtime differs.
  const base = [JSON.stringify(FILE_MARKER), JSON.stringify({ type: 'entity', name: 'Zed', entityType: 'x', observations: [''] })].join('\n');
  const pad = targetLen - base.length;
  assert.ok(pad >= 0, 'test setup: replacement base must not exceed the original length');
  const replacement = [JSON.stringify(FILE_MARKER), JSON.stringify({ type: 'entity', name: 'Zed', entityType: 'x', observations: ['z'.repeat(pad)] })].join('\n');
  assert.equal(replacement.length, targetLen, 'precondition: replacement has identical byte length');
  writeFileSync(file, replacement);
  // Advance mtime deterministically so the only distinguishing signal from the cache is mtime.
  const advanced = new Date(pinned.getTime() + 1000);
  utimesSync(file, advanced, advanced);

  const served = await mgr.readGraph(undefined, undefined, root);
  assert.equal(served.entities.length, 1);
  assert.equal(served.entities[0]!.name, 'Zed', 'a same-size change must still invalidate the cache via mtime');
});
