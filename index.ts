#!/usr/bin/env node

// 套件進入點（bin target）。實際接線邏輯位於以下模組：
//   config.ts   - CLI 參數、基底記憶路徑、檔案標記
//   storage.ts  - 路徑安全檢查、記憶檔案解析、KnowledgeGraphManager
//   search.ts   - 搜尋引擎（純函式 searchGraph）
//   audit.ts    - doctor 審計引擎（純函式 auditGraph）
//   tools.ts    - MCP 工具 schema 定義
//   server.ts   - 伺服器實例、請求處理器、main()

import { pathToFileURL } from 'url';
import { main } from './server.js';

// 僅在此模組被直接執行時（如透過 bin entry）啟動伺服器，
// 被匯入時（如測試）則不啟動。如此可保持純函式可匯入而不啟動 stdio transport。
// （2026-08-30 移除了 re-export：套件無 main/exports 且 files 只含 dist，
// 發佈形態下不存在程式化消費者；唯一的消費測試已改為直接匯入 storage.js。）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
  });
}
