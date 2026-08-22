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
- **`store` 對已存在實體是 no-op，但必須有聲**：名稱已存在者被跳過、observations 整批丟棄。過去回傳空陣列且無任何提示——呼叫端看起來像寫入成功，事實卻從未落地，舊事實因而繼續被當成現況召回（**本 repo 消滅靜默失敗的最後一個缺口**，2026-08-21 補上 warning 並改為 0 新增時不寫檔）
- **key 頭定義（跨工具共用）**：observation 的 key 頭是首個 `:` **或全形 `：`** 之前的片段（trim 後非空）。`duplicateCandidates`、`journalEntities`、`add_facts` 的 `upsertKeyed` 共用 `keyHeadOf`；只認半形會讓中文書寫的「別名：a／別名：b」永遠漏檢
- **`add_facts` 的 upsert 語義**：預設純追加（去重）；entry 帶 `upsertKeyed:true` 時，其 `key: value` 內容先刪掉該 entity 上同 key 頭的既有 observation 再追加，回傳另附 `replacedObservations`。**刻意 opt-in 不自動判斷**——實測真實圖譜中 `service: a`／`service: b` 這類合法多值鍵普遍存在，自動覆蓋會靜默刪除兄弟條目
- **`doctor` 的陳舊偵測**：`journalEntities` 抓「日期寫進 key 頭」造成的流水帳漂移（每寫一次生成新鍵 → 結構上不可被覆蓋 → 舊快照永久堆積且無工具看得見）。命中條件為帶日期鍵 ≥ 5 **且** 佔比 ≥ 30%，或存在剝掉日期後同槽的多個相異鍵；兩道門檻缺一就會製造警報疲勞（僅數量門檻會把「96 條裡 12 條帶日期」的正常長實體也報進來）。`unresolvedMarkers` 抓仍帶 `TODO`/`待確認` 類標記的 observation。**`SessionLog` 對三者（`duplicateCandidates` / `journalEntities` / `unresolvedMarkers`）皆豁免**（`AUDIT_EXEMPT_TYPES`）：duplicateCandidates 在它身上是結構性假陽性（`session <ts>｜…` 的首個 `:` 落在 ISO 時間戳內，同小時區塊歸為同鍵）、`pending` 區塊本來就在列未決事項必然命中 unresolvedMarkers——**必然命中的信號不是信號**，其體積與收斂由區塊保留上限負責
- **審計區段一律只回 `excerpts`（每組取樣 ≤ 3 條、各截斷 120 字元），`count` 保持精確，不逐字回吐 observation**：合法多值鍵（`service:` × 9、`known_pitfall:` × 8）與過時版本在引擎層無法區分，必須一律回報；判斷是哪一種三條摘錄已足夠，全吐只是把預算花在重複資訊上。實測某真實圖譜 doctor 報告因此從 14.5K 降到 8.3K 字元。需要全文時走 `get({names, observationPrefix})`。**設計前提是 doctor 會在每次 recall 被呼叫**（skill 端已如此規定），所以報告體積本身是契約的一部分
- **日期偵測只認 `\d{4}[-/]\d{1,2}[-/]\d{1,2}`（點號分隔排除）**：兩次收緊都是被誤報逼出來的——放寬到 `08-12` 短式會把版本號 `v3000.4.25` 的 `4.25` 當日期；改成強制四位年份後 `3000.4.25` 整串仍完全符合點分格式（點分版本號與點分日期結構上無法區分）。誤報會讓整個報告區段被無視，寧可漏掉 `2026.08.12` 寫法也不要污染信號。**改動此 pattern 前先確認回歸測試真的會紅**（該測試曾因觀察數未達門檻而假通過）
- **observation 級查詢**：`aim_memory_get` 可帶 `observationPrefix`/`observationSubstring`（恰一）只回命中條目並前置 `[obs-filter]` 抬頭；`aim_memory_count_observations`（唯讀、不回本文）回傳 `{totalObservations, matched, groups?}`（`groupByDelimiter` 分組），超大 entity 不需全量拉取
- **錯誤通道**：所有工具層錯誤（缺參數、實體不存在、workspace-only 拒絕等）一律回傳 `isError: true` 的正常 tools/call 結果（訊息在 `content[].text`），不得拋成協議級 JSON-RPC 錯誤——有客戶端會把協議級錯誤誤判為連線故障而殺掉重啟健康的 server 行程（重連風暴，對模型呈現為 "Failed to connect to MCP server"）
- **工具呼叫拒絕必帶「實際收到什麼」，且四條路徑一條都不能漏**：`assertToolCallArgs` 是單一驗證入口，依序判 `unknown-tool` → `arguments-key-absent` → `missing-required-args` → `missing-project-root`，**全部**走 `rejectToolCall`：訊息尾端附 `[diagnostic] tool=<name>; received keys: <k1,k2>; arguments bytes=<n>`，stderr 寫一行 `<Asia/Macau ISO8601> [aim-memory] tool call rejected (<reason>) — reqId=<JSON-RPC id>; <同一診斷>`。`received keys` 三種取值互斥且不可合併：具體鍵清單／`(none)`（送了空物件）／`(arguments key absent)`（params 根本沒有 arguments 鍵）。**⚠️ 新增任何拒絕路徑必須一併接上 `rejectToolCall`**——曾經只接了缺參數兩條，於是「整包 arguments 丟失」與「工具名損壞」靜默通過，而那兩者恰恰是客戶端故障最極端的形態，結果讓 README 的「stderr 無紀錄＝請求沒到伺服器」這條判讀規則本身產生假結論（2026-08-23 change-review 抓出並修正）。`reqId` 取自 SDK 的 `RequestHandlerExtra.requestId`，客戶端日誌以它索引，是兩份日誌能一一對應的關鍵。**只在拒絕路徑寫 stderr**（必然出現的信號不是信號），stdout 保留給 MCP 協議。stderr 前綴刻意用 `[aim-memory]`（客戶端掛載此 server 的慣用名稱）而非套件名，讓兩份日誌可用同一字串 grep。訊息主文常量 `PROJECT_ROOT_REQUIRED_MESSAGE` 定義在 storage.ts 並被 `getMemoryFilePath` 與 `listDatabases` 共用（單一真相），診斷抬頭只能在 server.ts 產生——storage 只收到解析後的 `projectRoot`，結構上看不到原始 arguments；storage 的同一道檢查保留為最後防線

## 已知坑（客戶端側，非本 repo 缺陷）

- **客戶端橋接層會間歇性丟失參數鍵**，最常見表現為誤報 `Workspace-only mode: projectRoot is required`：同一 payload 隔幾分鐘重試即成功、與內容大小／中英文／鍵序無關、持續數小時正常後突然一段窗口連續失敗再自愈。**重試即可**；持續失敗請檢查客戶端 MCP 連線狀態（重連風暴期間客戶端殺掉並重啟健康的 server 行程，重試時觀察到丟參數——2026-08-11/12 remove_facts/replace_fact「崩潰」即此成因）。判讀方式見上一條的 `received keys`：其餘鍵俱在獨缺一鍵＝客戶端丟鍵；`(none)`＝整包 arguments 丟失；**客戶端報錯但伺服器 stderr 無對應時間戳的紀錄＝請求根本沒到伺服器**（錯誤由客戶端自行合成）
- **伺服器端已排除嫌疑，勿重複調查**：`test/large-payload.test.ts` 以真實 server 子行程連續 50 輪 `store` + `add_facts`（每條 observation ≥ 8KB 中文、100 個請求一次灌進 stdin）全綠且落盤完整。該測試已通過突變檢查（人為在第 37 次呼叫刪掉 `projectRoot` → 測試變紅），確認它抓得到單次丟鍵，不是永遠綠的裝飾
- **客戶端也可能送「錯的」`projectRoot` 而非丟鍵，造成跨 workspace 記憶污染**：2026-08-23 實例——一個處理其他項目運維任務的並行 session 帶著本 repo 的 `projectRoot` 寫入，於是不相干的運維紀錄進了本 repo 圖譜，並順帶 prune 掉本 repo 的舊 SessionLog 區塊。**症狀**：`aim_memory_read_all` / SessionLog 出現與本項目無關的內容；自己的 `remove_facts` 回報 `removed: 0, unmatched`（因為目標區塊已被對方 prune 掉）。**這不是伺服器缺陷**：單一 server 行程跨 workspace 共享是既定架構，隔離完全依賴客戶端傳對 `projectRoot`。發現時檢查是否有並行 session 在跑，污染的 SessionLog 屬 transient 層會自然老化，durable 實體若被污染才需 `ask_user_question` 後清理
