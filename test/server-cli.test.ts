// Integration tests that spawn the compiled server over stdio and drive it with
// JSON-RPC. These cover behavior that depends on import-time CLI/env parsing and
// therefore cannot be unit-tested in-process:
//   M2 - --workspace-only=true (explicit value form) actually enables strict mode
//   M1 - workspace-only shapes the advertised schema (no 'location', requires
//        projectRoot, description carries a NOTE)
//   L3 - the request handler rejects calls missing a required data argument
//   plus a default-mode regression guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../index.js', import.meta.url));

const INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
};
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };

// Spawn the server with `args`, send `messages`, and resolve with all parsed
// stdout JSON objects once the response with id `waitForId` arrives (or timeout).
function driveServer(args: string[], messages: object[], waitForId: number, timeoutMs = 4000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SERVER, ...args], { stdio: ['pipe', 'pipe', 'ignore'] });
    const out: any[] = [];
    let buf = '';
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* noop */ }
      child.kill();
      resolve(out);
    };

    const timer = setTimeout(finish, timeoutMs);

    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
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
          // Ignore non-JSON lines (the server never emits any, but be safe).
        }
      }
    });

    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
  });
}

const callStore = (id: number, args: object) => ({
  jsonrpc: '2.0', id, method: 'tools/call',
  params: { name: 'aim_memory_store', arguments: args },
});
const listTools = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });

test('M2: --workspace-only=true (explicit value form) enables strict mode', async () => {
  const out = await driveServer(['--workspace-only=true'], [INIT, INITIALIZED, callStore(3, { entities: [] })], 3);
  const resp = out.find(m => m.id === 3);
  assert.ok(resp, 'expected a response for id 3');
  // 工具層錯誤以 isError 結果回傳（非協議級錯誤），見 tool-errors.test.ts 的契約說明。
  assert.ok(resp.result?.isError, 'strict mode must reject a store without projectRoot');
  assert.match(resp.result.content[0].text, /projectRoot is required/);
});

test('M1: workspace-only tools/list drops location and requires projectRoot with a NOTE', async () => {
  const out = await driveServer(['--workspace-only'], [INIT, INITIALIZED, listTools(2)], 2);
  const resp = out.find(m => m.id === 2);
  assert.ok(resp?.result?.tools, 'expected a tools list');
  for (const tool of resp.result.tools) {
    const props = (tool.inputSchema?.properties ?? {}) as Record<string, unknown>;
    assert.ok(!('location' in props), `${tool.name} must not expose 'location' in workspace-only mode`);
    assert.match(tool.description, /^\[workspace-only mode\]/, `${tool.name} description must carry the workspace-only note`);
    assert.ok((tool.inputSchema?.required ?? []).includes('projectRoot'), `${tool.name} must require projectRoot`);
  }
});

test('L3: handler rejects a call missing a required data argument', async () => {
  const out = await driveServer([], [INIT, INITIALIZED, callStore(4, {})], 4);
  const resp = out.find(m => m.id === 4);
  assert.ok(resp?.result?.isError, 'expected an isError result for a store without entities');
  assert.match(resp.result.content[0].text, /Missing required argument\(s\) for aim_memory_store: entities/);
});

test('default mode keeps location and omits the workspace-only note (regression)', async () => {
  const out = await driveServer([], [INIT, INITIALIZED, listTools(2)], 2);
  const resp = out.find(m => m.id === 2);
  const store = resp.result.tools.find((t: any) => t.name === 'aim_memory_store');
  assert.ok('location' in store.inputSchema.properties, 'default mode should keep location');
  assert.doesNotMatch(store.description, /workspace-only mode/);
});
