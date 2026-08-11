# AGENTS.md

## Project Overview

MCP knowledge-graph server（`mcp-knowledge-graph` fork）：為 AI 模型提供本地知識圖譜持久記憶（entities / relations / observations），TypeScript + Node.js 22+，`@modelcontextprotocol/sdk` over stdio。以 `--workspace-only` 嚴格模式執行時，記憶物理隔離在每個 workspace 的 `<projectRoot>/.aim/*.jsonl`，所有工具呼叫必帶 `projectRoot`。

四模組架構（全部位於 repo 根目錄）：

- `config.ts` — CLI 參數（minimist）、基底記憶路徑、`_aim` 檔案標記、`maxOutputChars`
- `storage.ts` — 路徑安全、JSONL 解析、KnowledgeGraphManager（CRUD + 搜尋 + 健檢）、mtime+size 讀取快取（回傳深拷貝）
- `tools.ts` — MCP 工具 schema 與給模型看的工具描述
- `server.ts` — stdio 伺服器接線、工具 handler、輸出格式化 / 分頁 / 截斷
- `index.ts` — bin 進入點

## Setup & Build

- Install: `npm install`
- Build: `npm run build`（輸出 `dist/`，`tsc -p tsconfig.build.json`）
- 部署事實：使用者的 aim-memory MCP 直接從本 repo 跑（`node dist/index.js --workspace-only`）；**改完必須 `npm run build` 並重啟 MCP server（Windsurf reload）才生效**。

## Testing

- Run all: `npm test`（`tsc -p tsconfig.test.json` + `node --test "dist/test/**/*.test.js"`，測試從編譯產物執行，改碼後必跑）
- 單檔：`npx tsc -p tsconfig.test.json && node --test dist/test/<name>.test.js`
- 測試位於 `test/*.test.ts`，node:test + assert/strict；stdio 整合測試以子行程 spawn 真實 server（寫入與讀取分兩個 session 避免 race）
- 本 repo 採 TDD：行為變更先寫失敗測試（RED）再實作（GREEN）

## Code Style

- 註釋與文檔一律繁體中文；格式化 `npm run format`（prettier）
- `exactOptionalPropertyTypes`：可選參數顯式 `| undefined`，見 `SearchOptions`

## 行為契約（對外可見，改動須同步 README 與 tools.ts 描述）

- **輸出上限**：讀取型工具（`read_all` / `search` / `get`）單次回傳硬上限 `maxOutputChars`（預設 50,000；`--max-output-chars` / `AIM_MAX_OUTPUT_CHARS`）
- **`read_all` 未分頁超限 → 自動分頁**：`autoPaginateText`（server.ts）以 entity 邊界切出放得進預算的最大第一頁，`[page]` 抬頭附 `nextOffset`，payload 保持格式有效（json 可解析）；連一個 entity 都放不下才退回 `capText` 硬切
- **明確分頁（offset/limit）超限、`search` / `get` 超限 → `capText` 硬切**並附指引（截斷會破壞 JSON，屬最後防線）
- 截斷 / 分頁只切 entity 邊界；relations 骨架每頁完整保留
