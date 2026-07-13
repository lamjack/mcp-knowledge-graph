// Tests for --workspace-only strict mode: memory is forced into
// <projectRoot>/.aim, projectRoot is mandatory (fail-closed), global storage
// and global listing are disabled, and default (non-strict) mode is unaffected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';

import { KnowledgeGraphManager, getMemoryFilePath } from '../storage.js';

function tmpRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'kg-ws-only-'));
}

test('workspace-only: getMemoryFilePath routes projectRoot into <root>/.aim', () => {
  const root = tmpRoot();
  const p = getMemoryFilePath(undefined, undefined, root, true);
  assert.equal(p, path.join(root, '.aim', 'memory.jsonl'));
});

test('workspace-only: getMemoryFilePath fails closed when projectRoot is missing', () => {
  assert.throws(() => getMemoryFilePath(undefined, undefined, undefined, true), /projectRoot is required/);
});

test('workspace-only: getMemoryFilePath rejects location:"global"', () => {
  const root = tmpRoot();
  assert.throws(() => getMemoryFilePath(undefined, 'global', root, true), /global storage is disabled/);
});

test('workspace-only manager: a mutation without projectRoot is rejected', async () => {
  const mgr = new KnowledgeGraphManager(true);
  await assert.rejects(
    () => mgr.createEntities([{ name: 'A', entityType: 't', observations: [] }]),
    /projectRoot is required/,
  );
});

test('workspace-only manager: reads are also rejected without projectRoot', async () => {
  const mgr = new KnowledgeGraphManager(true);
  await assert.rejects(() => mgr.readGraph(), /projectRoot is required/);
});

test('workspace-only manager: store + read stay confined to <projectRoot>/.aim', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager(true);

  await mgr.createEntities(
    [{ name: 'Alice', entityType: 'person', observations: ['likes tea'] }],
    undefined,
    undefined,
    root,
  );

  const file = path.join(root, '.aim', 'memory.jsonl');
  assert.ok(existsSync(file), 'memory must be written inside the workspace .aim');
  const marker = JSON.parse(readFileSync(file, 'utf-8').split('\n')[0]!);
  assert.equal(marker.type, '_aim');

  const graph = await mgr.readGraph(undefined, undefined, root);
  assert.equal(graph.entities.length, 1);
  assert.equal(graph.entities[0]!.name, 'Alice');
});

test('workspace-only manager: listDatabases requires projectRoot and never exposes global', async () => {
  const root = tmpRoot();
  const mgr = new KnowledgeGraphManager(true);

  await assert.rejects(() => mgr.listDatabases(), /projectRoot is required/);

  await mgr.createEntities([{ name: 'A', entityType: 't', observations: [] }], 'work', undefined, root);
  const res = await mgr.listDatabases(root);

  assert.deepEqual(res.global_databases, [], 'global databases must stay hidden in workspace-only mode');
  assert.ok(res.project_databases.includes('work'));
  assert.match(res.current_location, /workspace-only/);
});

test('default (non-strict) mode still resolves global storage (regression)', () => {
  // No throw: the pre-existing global fallback remains available when the flag is off.
  const p = getMemoryFilePath(undefined, 'global', undefined, false);
  assert.ok(p.endsWith('memory.jsonl'));
});
