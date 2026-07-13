#!/usr/bin/env node

// 套件進入點（bin target）。實際接線邏輯位於以下模組：
//   config.ts   - CLI 參數、基底記憶路徑、檔案標記
//   storage.ts  - 路徑安全檢查、記憶檔案解析、KnowledgeGraphManager
//   tools.ts    - MCP 工具 schema 定義
//   server.ts   - 伺服器實例、請求處理器、main()

import { pathToFileURL } from 'url';
import { main } from './server.js';

// 重新匯出無副作用（side-effect-free）的純函式，讓測試與任何程式化消費者
// 可從套件進入點直接匯入。
export {
  assertContextSafe,
  assertInScope,
  assertProjectRootSafe,
  getMemoryFilePath,
} from './storage.js';

// 僅在此模組被直接執行時（如透過 bin entry）啟動伺服器，
// 被匯入時（如測試）則不啟動。如此可保持純函式可匯入而不啟動 stdio transport。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
  });
}
