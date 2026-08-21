# AGENTS.md

## Project Overview

MCP knowledge-graph server（`mcp-knowledge-graph` fork）：為 AI 模型提供本地知識圖譜持久記憶（entities / relations / observations），TypeScript + Node.js 22+，`@modelcontextprotocol/sdk` over stdio。以 `--workspace-only` 嚴格模式執行時，記憶物理隔離在每個 workspace 的 `<projectRoot>/.aim/*.jsonl`，所有工具呼叫必帶 `projectRoot`。

四模組架構（全部位於 repo 根目錄）：

- `config.ts` — CLI 參數（minimist）、基底記憶路徑、`_aim` 檔案標記、`maxOutputChars`
- `storage.ts` — 路徑安全、JSONL 解析、KnowledgeGraphManager（CRUD + 搜尋 + 健檢）、mtime+size 讀取快取（回傳深拷貝）
- `tools.ts` — MCP 工具 schema 與給模型看的工具描述
- `server.ts` — stdio 伺服器接線、工具 handler（`dispatchTool`）、輸出格式化 / 分頁 / 截斷、工具錯誤通道（isError）
- `index.ts` — bin 進入點

## Setup & Build

- Install: `npm install`
- Build: `npm run build`（輸出 `dist/`，`tsc -p tsconfig.build.json`）
- 編輯器 TS：`.vscode/settings.json` 已把編輯器 tsserver 釘到 workspace 的 `node_modules/typescript`（Devin IDE 內建 TS 6.0（`types` 預設 `[]`）曾造成 `Cannot find name 'node:test'` 等假錯誤）；根 tsconfig 已顯式 `"types": ["node"]`，兩者缺一不可留意勿刪。
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
- **刪除回報（無靜默失敗）**：`aim_memory_remove_facts` 回傳 per-entity `[{entityName, entityExists, requested, removed, unmatched}]`——任何情況可分辨全刪／部分刪／0 命中／entity 不存在（不存在不丟錯、批次續跑）；deletion entry 的 `observations`（逐字）與 `observationPrefix`（前綴整批）恰一且非空；整批 0 刪除不寫檔
- **key 頭定義（跨工具共用）**：observation 的 key 頭是首個 `:` **或全形 `：`** 之前的片段（trim 後非空）。`duplicateCandidates`、`journalEntities`、`add_facts` 的 `upsertKeyed` 共用 `keyHeadOf`；只認半形會讓中文書寫的「別名：a／別名：b」永遠漏檢
- **`add_facts` 的 upsert 語義**：預設純追加（去重）；entry 帶 `upsertKeyed:true` 時，其 `key: value` 內容先刪掉該 entity 上同 key 頭的既有 observation 再追加，回傳另附 `replacedObservations`。**刻意 opt-in 不自動判斷**——實測真實圖譜中 `service: a`／`service: b` 這類合法多值鍵普遍存在，自動覆蓋會靜默刪除兄弟條目
- **`doctor` 的陳舊偵測**：`journalEntities` 抓「日期寫進 key 頭」造成的流水帳漂移（每寫一次生成新鍵 → 結構上不可被覆蓋 → 舊快照永久堆積且無工具看得見）。命中條件為帶日期鍵 ≥ 5 **且** 佔比 ≥ 30%，或存在剝掉日期後同槽的多個相異鍵；兩道門檻缺一就會製造警報疲勞（僅數量門檻會把「96 條裡 12 條帶日期」的正常長實體也報進來）。`SessionLog` **對 `journalEntities` 與 `duplicateCandidates` 皆豁免**（後者在它身上是結構性假陽性：`session <ts>｜…` 的首個 `:` 落在 ISO 時間戳內，同小時區塊歸為同鍵，照報還會把整批長文吐進報告淹掉真信號）。`unresolvedMarkers` 抓仍帶 `TODO`/`待確認` 類標記的 observation，`excerpts` 截斷至 120 字元控制報告體積
- **日期偵測只認 `\d{4}[-/]\d{1,2}[-/]\d{1,2}`（點號分隔排除）**：兩次收緊都是被誤報逼出來的——放寬到 `08-12` 短式會把版本號 `v3000.4.25` 的 `4.25` 當日期；改成強制四位年份後 `3000.4.25` 整串仍完全符合點分格式（點分版本號與點分日期結構上無法區分）。誤報會讓整個報告區段被無視，寧可漏掉 `2026.08.12` 寫法也不要污染信號。**改動此 pattern 前先確認回歸測試真的會紅**（該測試曾因觀察數未達門檻而假通過）
- **observation 級查詢**：`aim_memory_get` 可帶 `observationPrefix`/`observationSubstring`（恰一）只回命中條目並前置 `[obs-filter]` 抬頭；`aim_memory_count_observations`（唯讀、不回本文）回傳 `{totalObservations, matched, groups?}`（`groupByDelimiter` 分組），超大 entity 不需全量拉取
- **錯誤通道**：所有工具層錯誤（缺參數、實體不存在、workspace-only 拒絕等）一律回傳 `isError: true` 的正常 tools/call 結果（訊息在 `content[].text`），不得拋成協議級 JSON-RPC 錯誤——有客戶端會把協議級錯誤誤判為連線故障而殺掉重啟健康的 server 行程（重連風暴，對模型呈現為 "Failed to connect to MCP server"）
