// 執行時配置：CLI 參數、基底記憶目錄與檔案標記。
// 獨立出來讓儲存層與伺服器可匯入單一已解析的配置，無需重複解析 argv。

import path, { isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import minimist from 'minimist';

// 從 package.json 讀取版本 — 單一真實來源。
// 路徑為 '../package.json'，因為編譯後的程式碼從 dist/ 執行。
const require = createRequire(import.meta.url);
export const pkg = require('../package.json') as { version: string; name: string };

// 解析參數並安全處理路徑。
const argv = minimist(process.argv.slice(2));
let memoryPath = argv['memory-path'];

// 若提供了自訂路徑，確保其為絕對路徑。
if (memoryPath && !isAbsolute(memoryPath)) {
  memoryPath = path.resolve(process.cwd(), memoryPath);
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

// 處理記憶路徑 — 可能是檔案或目錄。
function resolveBaseMemoryPath(): string {
  if (memoryPath) {
    // 若 memory-path 指向 .jsonl 檔案，以其所在目錄作為基底。
    if (memoryPath.endsWith('.jsonl')) {
      return path.dirname(memoryPath);
    }
    // 否則將其視為目錄。
    return memoryPath;
  }
  return moduleDir;
}

// 全域記憶檔案的基底目錄。
export const baseMemoryPath: string = resolveBaseMemoryPath();

// 簡易標記用於識別本系統的檔案 — 防止寫入無關的 JSONL 檔案。
export const FILE_MARKER = {
  type: "_aim",
  source: "mcp-knowledge-graph"
};

// Workspace-only 嚴格模式：啟用後，每次工具呼叫都必須提供明確的 projectRoot，
// 全域儲存被停用，讀取／寫入／列表一律限縮在 <projectRoot>/.aim/ 之內。
// 透過 `--workspace-only` 旗標或 AIM_WORKSPACE_ONLY=true 環境變數啟用。
export const workspaceOnly: boolean =
  argv['workspace-only'] === true || process.env.AIM_WORKSPACE_ONLY === 'true';
