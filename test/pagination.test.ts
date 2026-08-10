// Tests for the large-graph safety features that prevent the MCP client from
// erroring on oversized read results ("Encountered unexpected error during
// execution"):
//   1. paginateGraph  - slice entities via offset/limit, relations kept whole
//   2. capText        - hard output-size cap (defense-in-depth net)
//   3. read_all over stdio honours offset/limit and emits a pagination header
//   4. --max-output-chars truncates oversized read output with guidance

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync } from 'node:fs';

import { paginateGraph, capText } from '../server.js';
import type { KnowledgeGraph } from '../storage.js';

const SERVER = fileURLToPath(new URL('../index.js', import.meta.url));

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

// --- stdio integration -----------------------------------------------------

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  },
};
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };

function driveServer(
  args: string[],
  messages: object[],
  waitForId: number,
  timeoutMs = 5000,
): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SERVER, ...args], { stdio: ['pipe', 'pipe', 'ignore'] });
    const out: any[] = [];
    let buf = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {
        /* noop */
      }
      child.kill();
      resolve(out);
    };
    const timer = setTimeout(finish, timeoutMs);
    child.on('error', err => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          out.push(obj);
          if (obj.id === waitForId) finish();
        } catch {
          /* ignore */
        }
      }
    });
    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
  });
}

function tmpRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'kg-page-'));
}

const call = (id: number, name: string, args: object) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

const storeMany = (id: number, root: string, n: number) =>
  call(id, 'aim_memory_store', {
    projectRoot: root,
    entities: Array.from({ length: n }, (_, i) => ({
      name: `E${i}`,
      entityType: 't',
      observations: [`obs${i}`],
    })),
  });

// Persist in one server session, then read in a second. Reads are file-backed and
// do not go through the per-file write serialization, so storing and reading within
// a single stdio session can race; two sessions against the same root are race-free.
async function seed(root: string, n: number, args: string[] = []): Promise<void> {
  const out = await driveServer(args, [INIT, INITIALIZED, storeMany(2, root, n)], 2);
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

test('read_all over stdio: --max-output-chars truncates oversized output with guidance', async () => {
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
  assert.match(text, /truncated/);
});
