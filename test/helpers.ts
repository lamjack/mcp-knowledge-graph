// stdio 整合測試的共享輔助：spawn 真實 server 子行程、逐行解析 stdout 的
// JSON-RPC 訊息，收到 waitForId 的回應（無論 result 或 error）即結束。
// 各 stdio 測試檔（pagination / tool-errors / observation-ops / projectroot-diagnostics
// / large-payload）共用此份，避免各自維護一份驅動碼。

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

// 一次 stdio session 的完整產出。stderr 收全文（含啟動橫幅），供斷言診斷日誌。
export interface ServerRun {
  messages: any[];
  stderr: string;
}

// 只要 stdout 的 JSON-RPC 訊息（既有呼叫端的簽名，未變）。
export async function driveServer(
  args: string[],
  messages: object[],
  waitForId: number,
  timeoutMs = 5000,
): Promise<any[]> {
  return (await runServer(args, messages, waitForId, timeoutMs)).messages;
}

// 同時取回 stderr。診斷輸出走 stderr（stdout 為 MCP 協議專用），
// 因此驗證診斷日誌必須實際接上子行程的 stderr 管線。
// env 供驗證環境變數形式的配置——MCP 客戶端設定檔多以 env 區塊傳參，
// 只測 CLI 旗標會讓實際最常用的那條路徑無人守衛。
export function runServer(
  args: string[],
  messages: object[],
  waitForId: number,
  timeoutMs = 5000,
  env?: Record<string, string>,
): Promise<ServerRun> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SERVER, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    const out: any[] = [];
    let buf = '';
    let err = '';
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
      resolve({ messages: out, stderr: err });
    };
    const timer = setTimeout(finish, timeoutMs);
    child.on('error', err => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      err += chunk;
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
