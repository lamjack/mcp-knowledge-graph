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

// 解析參數並安全處理路徑。將 workspace-only 宣告為布林旗標，讓 minimist
// 一致處理 `--workspace-only`、`--workspace-only=true/false`、`--no-workspace-only`，
// 避免 `--workspace-only true` 被解析成字串而靜默停用嚴格模式。
const argv = minimist(process.argv.slice(2), { boolean: ['workspace-only'] });
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

// 記憶檔案系統佈局的單一真相：專案本地目錄名與 JSONL 資料庫檔名 scheme。
// 集中於此，讓 storage 的檔名編碼（dbFileName）與解碼（dbNameFromFile）共用同一組常量，
// 避免 '.aim'、'memory.jsonl'、'memory-' 前綴、'.jsonl' 副檔名散落各處（改一處即全改）。
export const AIM_DIR_NAME = '.aim';
export const DB_FILE_EXT = '.jsonl';
export const DB_FILE_PREFIX = 'memory-';
export const MASTER_DB_FILE = `memory${DB_FILE_EXT}`;

// Workspace-only 嚴格模式：啟用後，每次工具呼叫都必須提供明確的 projectRoot，
// 全域儲存被停用，讀取／寫入／列表一律限縮在 <projectRoot>/.aim/ 之內。
// 透過 `--workspace-only` 旗標或 AIM_WORKSPACE_ONLY=true 環境變數啟用。
export const workspaceOnly: boolean =
  argv['workspace-only'] === true || process.env.AIM_WORKSPACE_ONLY === 'true';

// 讀取型工具（read_all / search / get）單次回傳文字的硬性字元上限（縱深防禦）。
// 大圖的整圖序列化可達數百 KB，超過 MCP 客戶端（如 Windsurf/Cascade）可吸收的上限時，
// 客戶端會以 "Encountered unexpected error during execution" 失敗。此上限確保回傳先被
// 優雅截斷並附指引，永不撐爆客戶端。可透過 `--max-output-chars` 或 AIM_MAX_OUTPUT_CHARS 覆寫。
// 預設值刻意保守（遠低於常見客戶端上限），因各客戶端實際上限未公開；建議搭配分頁與
// includeObservations:false 作為主要手段，此上限僅為最後防線。
const DEFAULT_MAX_OUTPUT_CHARS = 50_000;
function resolveMaxOutputChars(): number {
  const raw = argv['max-output-chars'] ?? process.env.AIM_MAX_OUTPUT_CHARS;
  const n = typeof raw === 'number' ? raw : (typeof raw === 'string' ? Number(raw) : NaN);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return DEFAULT_MAX_OUTPUT_CHARS;
}
export const maxOutputChars: number = resolveMaxOutputChars();
