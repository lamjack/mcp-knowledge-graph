# AGENTS.md

## Project Overview

MCP knowledge-graph server（`mcp-knowledge-graph` fork）：為 AI 模型提供本地知識圖譜持久記憶（entities / relations / observations），TypeScript + Node.js 22+，`@modelcontextprotocol/sdk` over stdio。以 `--workspace-only` 嚴格模式執行時，記憶物理隔離在每個 workspace 的 `<projectRoot>/.aim/*.jsonl`，所有工具呼叫必帶 `projectRoot`。

四模組架構（全部位於 repo 根目錄）：

- `config.ts` — CLI 參數（minimist）、基底記憶路徑、`_aim` 檔案標記、`maxOutputChars`
- `diagnostics.ts` — 診斷紀錄的單一出口：Asia/Macau 時間戳、stderr 行、可選檔案 sink。**server 的拒絕路徑與 storage 的損壞行紀錄共用它**（兩層各寫一份會讓格式與 sink 目標漂移，而事後對拍靠的正是格式一致）；只依賴 config，故兩層都能匯入而不成環
- `storage.ts` — 路徑安全、JSONL 解析、KnowledgeGraphManager（CRUD + 搜尋 + 健檢）、mtime+size 讀取快取（回傳深拷貝）
- `tools.ts` — MCP 工具 schema 與給模型看的工具描述
- `server.ts` — stdio 伺服器接線、工具派發表（`TOOL_HANDLERS`，取代原 15-case switch）、輸出格式化 / 分頁 / 截斷、工具錯誤通道（isError）
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
- **「0 變更不寫檔」是全部七條變更路徑的不變式**：`store`／`link`／`add_facts`／`forget`／`remove_facts`／`unlink`／`replace_fact` 在實際無任何變更時不觸碰記憶檔——多行程共用同一 JSONL 下，無謂寫入會 bump mtime 使其他行程快取全失效並擴大 lost-update 窗口。2026-08-30 補齊 `link`／`add_facts`／`forget`／`unlink` 四條（此前僅 `store`／`remove_facts`／`replace_fact` 有守衛），由 test/storage.test.ts 的四個 mtime 守衛測試鎖定
- **Tool annotations**：15 個工具全部帶 `readOnlyHint`／`destructiveHint`／`idempotentHint`／`openWorldHint:false`（7 唯讀／3 純附加／5 破壞性；`update_entity` 因 rename 不可重放而 `idempotentHint:false`）。分類由 tool-contract 測試逐工具鎖定；tools.ts 尾段的 workspace-only 後處理只碰 `inputSchema`／`description`，不得剝除 `annotations`（有 stdio 守衛）
- **key 頭定義（跨工具共用）**：observation 的 key 頭是首個 `:` **或全形 `：`** 之前的片段（trim 後非空）。`duplicateCandidates`、`journalEntities`、`add_facts` 的 `upsertKeyed` 共用 `keyHeadOf`；只認半形會讓中文書寫的「別名：a／別名：b」永遠漏檢
- **`add_facts` 的 upsert 語義**：預設純追加（去重）；entry 帶 `upsertKeyed:true` 時，其 `key: value` 內容先刪掉該 entity 上同 key 頭的既有 observation 再追加，回傳另附 `replacedObservations`。**刻意 opt-in 不自動判斷**——實測真實圖譜中 `service: a`／`service: b` 這類合法多值鍵普遍存在，自動覆蓋會靜默刪除兄弟條目
- **`doctor` 的陳舊偵測**：`journalEntities` 抓「日期寫進 key 頭」造成的流水帳漂移（每寫一次生成新鍵 → 結構上不可被覆蓋 → 舊快照永久堆積且無工具看得見）。命中條件為帶日期鍵 ≥ 5 **且** 佔比 ≥ 30%，或存在剝掉日期後同槽的多個相異鍵；兩道門檻缺一就會製造警報疲勞（僅數量門檻會把「96 條裡 12 條帶日期」的正常長實體也報進來）。`unresolvedMarkers` 抓仍帶 `TODO`/`待確認` 類標記的 observation。**`SessionLog` 對三者（`duplicateCandidates` / `journalEntities` / `unresolvedMarkers`）皆豁免**（`AUDIT_EXEMPT_TYPES`）：duplicateCandidates 在它身上是結構性假陽性（`session <ts>｜…` 的首個 `:` 落在 ISO 時間戳內，同小時區塊歸為同鍵）、`pending` 區塊本來就在列未決事項必然命中 unresolvedMarkers——**必然命中的信號不是信號**，其體積與收斂由區塊保留上限負責
- **審計區段一律只回 `excerpts`（每組取樣 ≤ 3 條、各截斷 120 字元），`count` 保持精確，不逐字回吐 observation**：合法多值鍵（`service:` × 9、`known_pitfall:` × 8）與過時版本在引擎層無法區分，必須一律回報；判斷是哪一種三條摘錄已足夠，全吐只是把預算花在重複資訊上。實測某真實圖譜 doctor 報告因此從 14.5K 降到 8.3K 字元。需要全文時走 `get({names, observationPrefix})`。**設計前提是 doctor 會在每次 recall 被呼叫**（skill 端已如此規定），所以報告體積本身是契約的一部分
- **日期偵測只認 `\d{4}[-/]\d{1,2}[-/]\d{1,2}`（點號分隔排除）**：兩次收緊都是被誤報逼出來的——放寬到 `08-12` 短式會把版本號 `v3000.4.25` 的 `4.25` 當日期；改成強制四位年份後 `3000.4.25` 整串仍完全符合點分格式（點分版本號與點分日期結構上無法區分）。誤報會讓整個報告區段被無視，寧可漏掉 `2026.08.12` 寫法也不要污染信號。**改動此 pattern 前先確認回歸測試真的會紅**（該測試曾因觀察數未達門檻而假通過）
- **observation 級查詢**：`aim_memory_get` 可帶 `observationPrefix`/`observationSubstring`（恰一）只回命中條目並前置 `[obs-filter]` 抬頭；`aim_memory_count_observations`（唯讀、不回本文）回傳 `{totalObservations, matched, groups?}`（`groupByDelimiter` 分組），超大 entity 不需全量拉取
- **名稱 alias 層（2026-08-30 根治，取代單純把錯誤訊息寫好）**：`resolveToolName` 接受上游官方 memory server 的九個工具名（`search_nodes` / `open_nodes` / `read_graph` / `create_entities` / …）、掉了 `aim_memory_` 前綴的形式、以及 `recall`（那是 `memory-graph-curation` 的 phase 名被當成工具名，對回 `read_all`）；`applyParamAliases` 接受同語義的參數變體（`name`/`entityName` → `names`、`names` → `entityNames`、`facts` → `observations`/`deletions`、`search` → `query`、`oldFact`/`oldObservation` → `matchExact`）。**canonical 名稱刻意與上游保持一致**——實查官方 README，上游的參數名（`names`/`entityNames`/`observations`/`deletions`/`query`/`entities`）與本 fork 完全相同，改成第三套詞彙只會讓模型的生態先驗失效。alias 三條守則缺一都會出事：canonical 已存在時不覆蓋、值的形狀必須放得進 canonical 的宣告形狀（由 schema 推導，不硬編碼）、改寫後刪掉 alias 鍵（否則 XOR 檢查與「未預期鍵」診斷都會誤判）。命中時回應前置一行 `[alias] accepted and rewritten: ...` 告知正名——alias 是善意相容層不是契約，不告知就會讓呼叫端永遠學不到正名。**刻意不寫進 tools.ts 描述**：那是每 session 的固定成本，而 alias 只在呼叫端寫錯時才需要，抬頭在需要的當下才出現
- **缺 `projectRoot` 的兩層後備（2026-08-30）**：關鍵差別是「是不是猜的」。① **MCP roots 是協議層正解**：客戶端宣告 `roots` 且 `listRoots()` **只回一個**時，那是客戶端明確告知的工作區，直接採用（回應前置 `[projectRoot] ... adopted the single workspace root reported by the client`）；回**多個**則語義不明，**絕不挑一個猜**，只列為候選。② 客戶端沒宣告 roots 時退回 `findProjectRoot()`（cwd 偵測），但結果**只放進錯誤訊息當候選、永不據以寫入**——workspace-only 的前提就是單一實例服務所有 workspace，而行程 cwd 是它啟動時的目錄：2026-08-30 實測兩個並存行程一個 `cwd=/`（偵測回 null）、一個剛好是某 workspace，足證此值不可信；2026-08-23 已發生過帶錯 projectRoot 造成的跨 workspace 污染。**對寫入 fail-closed 是刻意的**。客戶端的 roots 宣告狀態（`not-declared` / `declared` / `request-failed`）**折進既有那一行拒絕紀錄**而非另開一行——它必然伴隨該拒絕出現，另開一行就是製造必然信號（既有測試「診斷檔案為追寫而非覆寫」正是靠斷言行數抓到這點）。沒有這個欄位則事後無法分辨「沒宣告／回 0 個／回多個／宣告了卻答不出來」四種情況，而四者處理方式完全不同。`listRoots` 帶 2 秒超時，客戶端不回應不得卡住工具呼叫；宣告了卻請求失敗屬例外，另記一行 `roots/list failed`
- **`replace_fact` 的 `matchExact`**：能力缺口而非命名問題。實測 6 筆失敗都在表達「把這段原文換成那段」（`oldFact`/`oldObservation`），而當時只有 prefix/substring——拿 substring 硬代替會過度命中（`狀態: 好` 會連 `狀態: 好極了` 一起刪）。三種 match 模式恰擇一
- **損壞的 JSONL 行不得靜默丟棄**：載入時無法解析的行會被跳過（容忍損壞、不中止整個讀取），但**下一次任何寫入都以 `saveGraph` 整檔重寫 → 該筆資料永久消失**。故紀錄必須帶檔案路徑、1-based 行號（標記為第 1 行）與內容摘錄，並走 `diagnostics.recordDiagnostic` 與工具拒絕共用檔案 sink（stderr 不可依賴）。這是本 repo「消滅靜默失敗」目標下最後一個補上的缺口（2026-08-30）
- **XOR 參數約束必須寫進對外 schema**：`remove_facts` 的 deletion entry 與 `replace_fact` 用 `oneOf`（恰擇一）、`get` 用 `not.required`（至多一，因兩者皆可省略）。只在執行期強制會讓呼叫端只能靠失敗學習——實測 `replace_fact` 有 6 筆猜錯參數名
- **錯誤通道**：所有工具層錯誤（缺參數、實體不存在、workspace-only 拒絕等）一律回傳 `isError: true` 的正常 tools/call 結果（訊息在 `content[].text`），不得拋成協議級 JSON-RPC 錯誤——有客戶端會把協議級錯誤誤判為連線故障而殺掉重啟健康的 server 行程（重連風暴，對模型呈現為 "Failed to connect to MCP server"）
- **工具呼叫拒絕必帶「實際收到什麼」，且五條路徑一條都不能漏**：`assertToolCallArgs` 是單一驗證入口，依序判 `unknown-tool` → `arguments-key-absent` → `missing-required-args` → `missing-project-root`，`dispatchTool` 再判 `tool-not-dispatchable`（已宣告但未接線；結構上不可達，由 `test/tool-contract.test.ts` 的「派發表 ≡ 工具定義」守衛，已以突變檢查實測），**全部**走 `rejectToolCall`：訊息尾端附 `[diagnostic] tool=<name>; received keys: <k1,k2>; arguments bytes=<n>`，stderr 寫一行 `<Asia/Macau ISO8601> [aim-memory] tool call rejected (<reason>) — reqId=<JSON-RPC id>; <同一診斷>`。`received keys` 三種取值互斥且不可合併：具體鍵清單／`(none)`（送了空物件）／`(arguments key absent)`（params 根本沒有 arguments 鍵）。**⚠️ 新增任何拒絕路徑必須一併接上 `rejectToolCall`**——曾經只接了缺參數兩條，於是「整包 arguments 丟失」與「工具名損壞」靜默通過，而那兩者恰恰是客戶端故障最極端的形態，結果讓 README 的「stderr 無紀錄＝請求沒到伺服器」這條判讀規則本身產生假結論（2026-08-23 change-review 抓出並修正）。`reqId` 取自 SDK 的 `RequestHandlerExtra.requestId`，客戶端日誌以它索引，是兩份日誌能一一對應的關鍵。**只在拒絕路徑寫 stderr**（必然出現的信號不是信號），stdout 保留給 MCP 協議。stderr 前綴刻意用 `[aim-memory]`（客戶端掛載此 server 的慣用名稱）而非套件名，讓兩份日誌可用同一字串 grep。訊息主文常量 `PROJECT_ROOT_REQUIRED_MESSAGE` 定義在 storage.ts 並被 `getMemoryFilePath` 與 `listDatabases` 共用（單一真相），診斷抬頭只能在 server.ts 產生——storage 只收到解析後的 `projectRoot`，結構上看不到原始 arguments；storage 的同一道檢查保留為最後防線

- **拒絕紀錄的可選檔案 sink**：`--diagnostic-log <path>` 或 `AIM_DIAGNOSTIC_LOG`（`config.ts` 的 `diagnosticLogPath`，相對路徑比照 `--memory-path` 以 cwd 解析）。存在的理由是 **stderr 不可依賴**：實測 Devin 產生的 server 行程 FD2 直接指向 `/dev/null`（`lsof -p <pid>` 確認），stderr 那行連同 `reqId` 全被丟棄，事後對拍在該客戶端上根本不成立。行為：預設關閉（未配置不產生任何檔案）／只在拒絕路徑追寫／追寫不覆寫（要診斷的正是連續失敗的窗口）／寫檔失敗只降級為 stderr 警告，絕不弄壞工具回應

## 已知坑

- **⚠️ 拒絕的主因是呼叫端用錯名稱，不是客戶端丟鍵（2026-08-30 以真實 sink 資料修正歸因）**：某真實環境累積 56 筆拒絕紀錄的實測分佈為 `unknown-tool` 21 筆（38%）／`missing-required-args` 25 筆（45%）／`missing-project-root` 10 筆（18%）。前兩類是**本 repo 可處理**的名稱問題：工具名誤用上游官方 memory server 的名稱（`aim_memory_search_nodes` ×9、`aim_memory_open_nodes`、`aim_memory_read`）或掉前綴（`search`、`list_stores`）——本 fork 改名後模型退回訓練先驗；參數名則是單複數／同義詞漂移（`get` 要 `names` 收到 `name` ×10、`entityName` ×3；`replace_fact` 收到 `oldFact/newFact` ×4）。**因此 `unknown-tool` 與 `missing-required-args` 的訊息都帶 did-you-mean 建議**（`suggestToolName` / `suggestKeyFix`，重用 storage 的 `boundedLevenshtein`），unknown-tool 另附完整工具清單——成本不對稱：宿主在工具錯誤時會附整份 tools/list（實測 40KB），訊息裡幾百字元的線索遠比讓呼叫端再錯一輪便宜。**此前 README／AGENTS.md／圖譜三處都把拒絕一律歸因為客戶端丟鍵並建議「重試即可」，那會讓真正該修的（呼叫端規則沒帶 projectRoot、名稱用錯）被當成客戶端 bug**
- **客戶端橋接層確實會間歇性丟失參數鍵，但屬較少數**：判準是**其餘鍵俱在、獨缺一鍵**；同一 payload 隔幾分鐘重試即成功、與內容大小／中英文／鍵序無關、持續數小時正常後突然一段窗口連續失敗再自愈。**這一類重試即可**；持續失敗請檢查客戶端 MCP 連線狀態。⚠️ **只送了一個鍵時（如 `received keys: entities`）無法區分丟鍵與呼叫端從未帶**，先查呼叫端規則（重連風暴期間客戶端殺掉並重啟健康的 server 行程，重試時觀察到丟參數——2026-08-11/12 remove_facts/replace_fact「崩潰」即此成因）。判讀方式見上一條的 `received keys`：其餘鍵俱在獨缺一鍵＝客戶端丟鍵；`(none)`＝整包 arguments 丟失；**客戶端報錯但伺服器 stderr 無對應時間戳的紀錄＝請求根本沒到伺服器**（錯誤由客戶端自行合成）
- **伺服器端已排除嫌疑，勿重複調查**：`test/large-payload.test.ts` 以真實 server 子行程連續 50 輪 `store` + `add_facts`（每條 observation ≥ 8KB 中文、100 個請求一次灌進 stdin）全綠且落盤完整。該測試已通過突變檢查（人為在第 37 次呼叫刪掉 `projectRoot` → 測試變紅），確認它抓得到單次丟鍵，不是永遠綠的裝飾
- **多個客戶端 = 多個 server 行程共用同一份 JSONL，且跨行程無寫入互斥**：2026-08-23 實測同時有三個行程跑 `dist/index.js --workspace-only`——parent 分別是 Devin 的 `devin acp`、Devin 的 `language_server`、DataGrip 的 Codeium `language_server`。`runExclusive`（`storage.ts` 的 `writeChains`）掛在 manager 實例上，**只能 per-process 互斥**，跨行程的 read-modify-write 存在 lost-update 窗口（風險已識別，尚未觀察到確定的資料遺失）。另一個推論：**重啟一個客戶端不等於舊碼行程消失**——當時 DataGrip 那個行程已從前一天跑到現在，仍在執行改版前的舊碼。改完 `dist` 後若某個客戶端行為與預期不符，先 `ps aux | grep knowledge-graph-mcp` 看有幾個行程、各自何時啟動
- **客戶端也可能送「錯的」`projectRoot` 而非丟鍵，造成跨 workspace 記憶污染**：2026-08-23 實例——一個處理其他項目運維任務的並行 session 帶著本 repo 的 `projectRoot` 寫入，於是不相干的運維紀錄進了本 repo 圖譜，並順帶 prune 掉本 repo 的舊 SessionLog 區塊。**症狀**：`aim_memory_read_all` / SessionLog 出現與本項目無關的內容；自己的 `remove_facts` 回報 `removed: 0, unmatched`（因為目標區塊已被對方 prune 掉）。**這不是伺服器缺陷**：單一 server 行程跨 workspace 共享是既定架構，隔離完全依賴客戶端傳對 `projectRoot`。發現時檢查是否有並行 session 在跑，污染的 SessionLog 屬 transient 層會自然老化，durable 實體若被污染才需 `ask_user_question` 後清理
