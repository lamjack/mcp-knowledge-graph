// stdio 整合測試的共享輔助：spawn 真實 server 子行程、逐行解析 stdout 的
// JSON-RPC 訊息，收到 waitForId 的回應（無論 result 或 error）即結束。
// 三個 stdio 測試檔（pagination / tool-errors / observation-ops）共用此份，
// 避免各自維護一份驅動碼。

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync } from 'node:fs';

export const SERVER = fileURLToPath(new URL('../index.js', import.meta.url));

export const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  },
};
export const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };

export const call = (id: number, name: string, args: object) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

// 每個測試檔傳自己的前綴（如 'kg-page-'），讓暫存目錄可辨來源。
export function tmpRoot(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function driveServer(
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
