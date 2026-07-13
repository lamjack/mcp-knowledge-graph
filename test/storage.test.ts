// Integration tests for the storage layer: round-trip persistence via an
// explicit projectRoot (the multi-workspace path), atomic file creation with
// the _aim marker, and the safety guard against overwriting unrelated files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';

import { KnowledgeGraphManager } from '../storage.js';

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
