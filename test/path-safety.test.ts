// getMemoryFilePath 路徑穿越防護的回歸測試。
//
// 涵蓋 issue #21 回報的漏洞：`context` 值未經驗證就直接插入檔名
// （`memory-${context}.jsonl`），允許 `../` 穿越逃離設定的儲存目錄，
// 在建立/儲存路徑上造成安全風險。
//
// 執行方式：npm test（先編譯，再以 node:test 執行編譯後的測試）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, writeFileSync } from 'node:fs';

// 從編譯後的模組匯入。伺服器的 main() 有守衛，
// 因此在此匯入不會啟動 stdio transport。
import { assertContextSafe, assertInScope, assertProjectRootSafe, getMemoryFilePath } from '../storage.js';

test('assertContextSafe accepts ordinary context identifiers', () => {
  for (const ok of ['work', 'personal', 'health', 'project_2024', 'a-b.c', 'A1']) {
    assert.doesNotThrow(() => assertContextSafe(ok), `expected "${ok}" to be accepted`);
  }
});

test('assertContextSafe rejects path separators', () => {
  for (const bad of ['a/b', 'a\\b', 'work/../../etc']) {
    assert.throws(() => assertContextSafe(bad), /path separators|only letters/, `expected "${bad}" to be rejected`);
  }
});

test('assertContextSafe rejects traversal segments', () => {
  for (const bad of ['..', '.']) {
    assert.throws(() => assertContextSafe(bad), /traversal segments/, `expected "${bad}" to be rejected`);
  }
});

test('assertContextSafe rejects the issue #21 payload', () => {
  // 回報者的穿越範例：足夠的 ../ 到達任意行程可寫入位置。
  // 斜線使其直接失敗。
  assert.throws(() => assertContextSafe('../../../../tmp/pwned'), /path separators/);
});

test('assertContextSafe rejects empty and non-string input', () => {
  assert.throws(() => assertContextSafe(''), /non-empty string/);
  // @ts-expect-error 刻意誤用以覆蓋執行時防護
  assert.throws(() => assertContextSafe(undefined), /non-empty string/);
  // @ts-expect-error 刻意誤用以覆蓋執行時防護
  assert.throws(() => assertContextSafe(123), /non-empty string/);
});

test('assertContextSafe rejects characters outside the allow-list', () => {
  for (const bad of ['a b', 'a:b', 'a*b', 'a$b', 'café']) {
    assert.throws(() => assertContextSafe(bad), /only letters/, `expected "${bad}" to be rejected`);
  }
});

test('assertInScope accepts a target inside the base directory', () => {
  const base = path.resolve('/tmp/kg-base');
  const target = path.join(base, 'memory-work.jsonl');
  assert.doesNotThrow(() => assertInScope(target, base));
});

test('assertInScope rejects a target that escapes the base directory', () => {
  const base = path.resolve('/tmp/kg-base');
  const escaped = path.join(base, '..', '..', 'tmp', 'pwned.jsonl');
  assert.throws(() => assertInScope(escaped, base), /escapes the configured storage directory/);
});

test('assertInScope rejects the base directory itself', () => {
  const base = path.resolve('/tmp/kg-base');
  assert.throws(() => assertInScope(base, base), /escapes the configured storage directory/);
});

test('assertInScope rejects an absolute path outside base', () => {
  const base = path.resolve('/tmp/kg-base');
  assert.throws(() => assertInScope('/etc/passwd', base), /escapes the configured storage directory/);
});

// assertProjectRootSafe 守護多工作區的 `projectRoot` 參數。
// 在 Windsurf 等用戶端中，伺服器的 cwd 不可靠，因此用戶端
// 明確傳入工作區根目錄；我們只接受已存在的絕對路徑目錄，
// 以避免歧義與散落的 `.aim` 目錄建立。

test('assertProjectRootSafe accepts an existing absolute directory', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kg-root-'));
  assert.doesNotThrow(() => assertProjectRootSafe(dir));
});

test('assertProjectRootSafe rejects relative paths', () => {
  for (const bad of ['relative/dir', './here', '../up']) {
    assert.throws(() => assertProjectRootSafe(bad), /absolute path/, `expected "${bad}" to be rejected`);
  }
});

test('assertProjectRootSafe rejects empty and non-string input', () => {
  assert.throws(() => assertProjectRootSafe(''), /non-empty string/);
  // @ts-expect-error 刻意誤用以覆蓋執行時防護
  assert.throws(() => assertProjectRootSafe(undefined), /non-empty string/);
  // @ts-expect-error 刻意誤用以覆蓋執行時防護
  assert.throws(() => assertProjectRootSafe(123), /non-empty string/);
});

test('assertProjectRootSafe rejects a non-existent absolute path', () => {
  const missing = path.join(os.tmpdir(), `kg-does-not-exist-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  assert.throws(() => assertProjectRootSafe(missing), /does not exist/);
});

test('assertProjectRootSafe rejects a path that is a file, not a directory', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kg-root-'));
  const file = path.join(dir, 'not-a-dir.txt');
  writeFileSync(file, 'hello');
  assert.throws(() => assertProjectRootSafe(file), /not a directory/);
});

// 核心多工作區路由：明確的 projectRoot 必須解析至
// 該 repo 專屬的 `.aim/` 目錄，不受伺服器 cwd 影響。

test('getMemoryFilePath routes a projectRoot to <projectRoot>/.aim/memory.jsonl', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kg-ws-'));
  const resolved = getMemoryFilePath(undefined, undefined, root);
  assert.equal(resolved, path.join(root, '.aim', 'memory.jsonl'));
});

test('getMemoryFilePath routes a projectRoot + context to a suffixed file', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kg-ws-'));
  const resolved = getMemoryFilePath('work', undefined, root);
  assert.equal(resolved, path.join(root, '.aim', 'memory-work.jsonl'));
});

test('getMemoryFilePath with projectRoot still rejects a traversal context', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kg-ws-'));
  assert.throws(() => getMemoryFilePath('../../etc/pwned', undefined, root), /path separators/);
});
