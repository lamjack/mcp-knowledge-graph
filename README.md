# MCP Knowledge Graph

**透過本地知識圖譜為 AI 模型提供持久記憶的 MCP 伺服器。**

使用實體（entities）、關係（relations）與觀察（observations）跨對話儲存和擷取資訊。支援任何 MCP 相容的 AI 平台。

> 本 fork 專為 **Windsurf 等多工作區 IDE** 設計：透過 `--workspace-only` 嚴格模式，把記憶強制隔離在各 workspace 的 `.aim/` 目錄。安裝只提供本地 `git clone`，部署只提供 Windsurf workspace 分離方式。

## 概覽

本伺服器將記憶以知識圖譜結構持久化於本地 JSONL 檔案中，讓 AI 模型能在不同對話之間保留和查詢資訊。核心設計圍繞 **AIM（AI Memory）** 命名體系，透過 `.aim` 目錄、`aim_` 工具前綴與 `_aim` 檔案標記提供清晰組織與安全性。

### AIM 命名體系

- **`.aim` 目錄**：存放 AI 記憶檔案，易於識別與管理
- **`aim_` 工具前綴**：在多工具環境中將記憶相關功能分組
- **`_aim` 安全標記**：每個記憶檔案以 `{"type":"_aim","source":"mcp-knowledge-graph"}` 開頭，防止誤寫無關的 JSONL 檔案

### `.aim` 目錄 vs `_aim` 檔案標記

兩者名稱相似但用途不同：

- **`.aim`** = 專案本地目錄名稱（必須精確命名為 `.aim`，專案偵測才能運作）
- **`_aim`** = 檔案安全標記（出現在 JSONL 檔案內部：`{"type":"_aim","source":"mcp-knowledge-graph"}`）

**workspace 本地儲存：** 目錄必須命名為 `.aim`，置於 workspace/專案根目錄，例如 `my-project/.aim/memory.jsonl`。`--workspace-only` 模式下記憶固定落在此處，不使用全域目錄。

### 主資料庫概念

主資料庫（master database）是預設的記憶儲存，未指定資料庫時一律使用它。在列表中顯示為 `default`，檔案名為 `memory.jsonl`。

- **預設行為**：所有記憶操作預設使用主資料庫
- **workspace 本地**：儲存於當前 workspace 的 `.aim/`（`memory.jsonl`）
- **主要儲存**：跨所有對話持久化的主要知識圖譜
- **命名資料庫**：可選的額外資料庫（`work`、`personal`、`health`），按主題組織

## 安裝（本地 git clone）

> ⚠️ 本 fork 的 `projectRoot` / `--workspace-only` 功能**尚未發佈到 npm**。`npx -y mcp-knowledge-graph` 會抓到不含這些功能的上游套件，請務必用本地建置。

### 先決條件

- Node.js 22+
- Windsurf（或其他支援 MCP stdio 的 AI 平台）

### 取得並建置

```bash
git clone https://github.com/lamjack/mcp-knowledge-graph.git
cd mcp-knowledge-graph
npm install        # 安裝依賴（postinstall 會自動 build 出 dist/）
npm run build      # 重新編譯（可選）
npm test           # 執行測試（可選）
```

建置後記下 `dist/index.js` 的**絕對路徑**，Windsurf 配置會用到。

### 驗證建置

建置完成後 `dist/` 目錄應包含編譯後的 JavaScript 檔案：

```text
dist/
├── index.js
├── config.js
├── storage.js
├── tools.js
└── server.js
```

## 架構入口

系統由四個模組組成，各司其職：

| 檔案　　　　 | 用途　　　　　　　　　　　　　　　　　　　　　　　　　　 |
| --------------| ----------------------------------------------------------|
| `config.ts`　| CLI 參數解析、基底記憶路徑、檔案標記定義　　　　　　　　 |
| `storage.ts` | 路徑安全檢查、記憶檔案解析、知識圖譜資料模型與持久化操作 |
| `tools.ts`　 | MCP 工具 schema 定義　　　　　　　　　　　　　　　　　　 |
| `server.ts`　| 伺服器實例、請求處理器與 `main()` 進入點　　　　　　　　 |
| `index.ts`　 | 套件進入點（bin target），匯入並啟動 `server.ts`　　　　 |

### 儲存邏輯

**檔案位置（`--workspace-only` 模式）：**

1. **固定落於 `<projectRoot>/.aim/memory.jsonl`** — `projectRoot` 由 client（Cascade）以當前 workspace 絕對路徑傳入
2. **指定 context** — 加後綴：`memory-work.jsonl`、`memory-personal.jsonl`
3. **無全域退路** — 缺少 `projectRoot` 直接報錯，不會誤寫全域

**安全系統：**

- 每個記憶檔案以 `{"type":"_aim","source":"mcp-knowledge-graph"}` 開頭
- 系統拒絕寫入不含此標記的檔案
- 防止誤覆寫無關的 JSONL 檔案

### 持久化語義（per-operation read-modify-write + 讀取快取）

每次工具呼叫都是獨立的 **read-modify-write**：

1. 讀取（或重用快取）當前 JSONL → 2. 在記憶體中修改 → 3. 以暫存檔 + `rename()` 原子寫回整個檔案。

- **同檔操作序列化**：同一檔案的並發呼叫會排隊執行，避免彼此覆寫（跨 workspace 的單一伺服器行程尤其重要）。
- **原子寫入**：先寫 `.tmp` 再 `rename`（同檔案系統上為原子操作），寫入中途崩潰不會留下截斷/損壞的記憶檔。
- **讀取快取**：已解析的圖譜以 **`mtime`（nanosecond 精度）+ `size`** 為鍵快取，純為效能優化。任何不一致都會退回重新讀檔並重新解析；快取只回傳深拷貝，呼叫端無法透過回傳值污染快取。
- **外部直接編輯 JSONL 是安全的**：因為快取以 `mtime + size` 失效，你在伺服器外手動編輯 `.aim/*.jsonl`（並保留首行 `_aim` 標記）後，下一次操作會偵測到檔案變動並重新載入，不會復活你刪掉的資料，也不會讀到陳舊快取。（極端情況：若在**同一時間戳**內把檔案改成**完全相同的位元組長度**，理論上可能命中舊快取；一般手動編輯不會遇到。）

## 使用方式

### 資料庫概念

記憶以「資料庫」組織：預設主資料庫為 `memory.jsonl`；可選的命名資料庫（如 `work`）會加後綴成 `memory-work.jsonl`。所有資料庫都位於當前 workspace 的 `.aim/` 目錄下，透過 `context` 參數切換。

### AI 如何使用資料庫

AI 模型預設使用主資料庫，也可透過 `context` 參數指定命名資料庫。新資料庫自動建立，無需額外設定。

> `--workspace-only` 模式下**每次呼叫都必須帶 `projectRoot`**（當前 workspace 絕對路徑）；為簡潔，下列僅第一個範例顯示。

```json
// 主資料庫（預設，無需 context）
aim_memory_store({
  projectRoot: "/Users/you/dev/my-project",
  entities: [{
    name: "John_Doe",
    entityType: "person",
    observations: ["Met at conference"]
  }]
})

// 工作資料庫
aim_memory_store({
  context: "work",
  entities: [{
    name: "Q4_Project",
    entityType: "project",
    observations: ["Due December 2024"]
  }]
})

// 個人資料庫
aim_memory_store({
  context: "personal",
  entities: [{
    name: "Mom",
    entityType: "person",
    observations: ["Birthday March 15th"]
  }]
})
```

### 檔案組織

每個 workspace 的記憶檔案都在自己的 `.aim/` 目錄下：

```tree
my-project/
├── .aim/
│   ├── memory.jsonl       # workspace 主資料庫（預設）
│   └── memory-work.jsonl  # workspace 工作資料庫
└── src/
```

## 可用工具

- `aim_memory_store` — 儲存新記憶（人物、專案、概念）。若新 `entityType` 與既有型別僅差大小寫/底線/連字符，回傳會附 `warnings`（不阻斷寫入）
- `aim_memory_add_facts` — 向既有記憶新增事實
- `aim_memory_link` — 連結兩個記憶。**預設對不存在的端點報錯**（防幽靈節點）；傳 `allowDangling:true` 可還原舊的寬鬆行為
- `aim_memory_search` — 依關鍵字搜尋記憶
- `aim_memory_get` — 依確切名稱擷取特定記憶
- `aim_memory_read_all` — 讀取資料庫中所有記憶
- `aim_memory_list_stores` — 列出可用資料庫
- `aim_memory_forget` — 遺忘記憶
- `aim_memory_remove_facts` — 移除記憶中的特定事實
- `aim_memory_unlink` — 移除記憶之間的連結

### 策展與防呆工具

- `aim_memory_update_entity` — **原地**更新實體：改名與/或改 `entityType`，保留 observations（順序不變）。改名會連帶重寫所有 relation 的 `from`/`to` 端點；改名撞到既有名稱則報錯不覆蓋。避免「forget → store → 重新 link」的轉錄風險。參數：`name`（必填）、`newName?`、`entityType?`（後兩者至少給一個）
- `aim_memory_replace_fact` — 原子「刪舊補新」：刪除某實體所有命中（`matchPrefix` 或 `matchSubstring` 二擇一）的 observation，並在**同一次寫入**追加 `newText`。回傳 `{matched, replaced}`；0 命中時不追加並回傳 `{matched:0, replaced:false}`（不靜默 no-op）。適合取代 key 型 observation（如「開發計畫編號: ...」）。參數：`entityName`、`newText`（必填）、`matchPrefix?`/`matchSubstring?`（恰一）
- `aim_memory_doctor` — 唯讀圖譜審計，回傳 `orphans`（無關係的孤兒實體）、`danglingRelations`（端點不存在的關係）、`typeCollisions`（僅差格式的 entityType 分組）、`duplicateCandidates`（同實體內共用 `:` key 前綴的多條 observation）、`stats`（entity/relation/observation 計數與型別分佈）。針對單一資料庫（`context` 或 default）運作
- `aim_memory_list_entity_types` — 唯讀，回傳各 `entityType` 與其實體計數（數量多者在前），供型別詞彙治理

### 參數

- `context`（可選）— 指定命名資料庫（`work`、`personal` 等）。預設為主資料庫
- `projectRoot`（**`--workspace-only` 下必填**）— 當前 workspace/專案根目錄的絕對路徑，記憶儲存於 `<projectRoot>/.aim/`
- `location`（可選）— 強制儲存位置。`--workspace-only` 模式下僅接受 `project`，`global` 會被拒絕
- `format`（可選，讀取類工具）— 輸出格式：`json`（預設，結構化）、`pretty`（人類可讀）、`concise`（token 精簡，單行一實體，最適合回填大模型 context）
- `limit`（可選，`aim_memory_search`）— 只回傳相關性最高的前 N 個命中實體（seeds）。相關性排序：name 完全命中 > name 子字串 > type > observation。由 `depth` 帶入的鄰居不計入此上限
- `depth`（可選，`aim_memory_search`，預設 `1`）— 由每個命中實體向外擴展的關係跳數，帶入鄰居提供脈絡。設為 `0` 只回傳命中實體與其之間的關係
- `includeObservations`（可選，`aim_memory_read_all` / `aim_memory_get`，預設 `true`）— 設為 `false` 時只回傳每個 entity 的 `name` + `entityType`（省略 observations）與完整關係骨架，供審計/索引大圖時避免數百 KB 輸出被截斷
- `offset` / `limit`（可選，`aim_memory_read_all`）— 以 entity 為單位分批讀取大圖；relations 骨架每頁完整回傳。帶分頁時輸出前置 `[page]` 抬頭，標示本頁範圍與下一頁的 `offset`

### 輸出大小上限與自動分頁

讀取型工具（`read_all` / `search` / `get`）的單次回傳有硬性字元上限（預設 50,000，可用 `--max-output-chars` 或 `AIM_MAX_OUTPUT_CHARS` 覆寫），避免超大輸出撐爆 MCP 客戶端（"Encountered unexpected error during execution"）：

- **`read_all` 未帶 `offset`/`limit` 且全圖超過上限**：自動降級為「放得進預算的最大第一頁」（entity 邊界切齊、relations 骨架完整、格式保持有效），前置 `[page]` 抬頭附下一頁 `offset`——逐頁續讀即可走完全圖，不會收到截斷的破損 JSON。
- **明確分頁（帶 `offset`/`limit`）後仍超過上限**：退回硬性截斷並附指引（請縮小 `limit`）；`search` / `get` 超限同樣走硬性截斷。
- 大圖建議搭配 `includeObservations: false` 或 `format: "concise"` 先讀骨架，再對目標實體取完整內容。
- `allowDangling`（可選，`aim_memory_link`，預設 `false`）— 逃生門。預設會拒絕指向不存在端點的連結；設 `true` 允許建立端點尚不存在的關係（舊寬鬆行為）

### 搜尋行為（相關性排序 + ego-graph 擴展）

`aim_memory_search` 會對每個實體評分後依相關性排序，並預設擴展 1 跳鄰居，確保命中實體的關係與上下文不被丟棄（即使鄰居本身未命中關鍵字）。搭配 `limit` 可只取 top-k、搭配 `format:"concise"` 可大幅降低回填 context 的 token 量。

**多詞查詢（分詞比對）**：查詢含多個詞（以空白/標點分隔）時，會分別比對各詞，只要 name/type/observation 命中其中任一詞即計分：

- **詞覆蓋**：命中越多不同查詢詞的實體排序越前（例如查 `seattle trip`，同時含 `trip` 與 `seattle` 者優先於只含其一者）。
- **整詞權重**：整詞命中（word-boundary）權重高於中段子字串（`cat` 這個完整詞 > `category` 中的 `cat`）。
- **IDF 加權**：出現在越多實體的通用詞權重越低、稀有詞越高（例如查 `lamtrade timezone`，`lamtrade` 幾乎人人有 → 由 `timezone` 主導排序，timezone 相關實體浮上前列）。
- **長度正規化**：observation 越多的實體，單則命中的邊際貢獻越低，避免長 hub 純靠「命中數量」霸榜。
- **typo 容忍（fuzzy fallback）**：某個查詢詞在語料中**完全無精確子字串命中**且長度 ≥4 時，才啟用受限編輯距離近似比對（長度 ≥7 容許 2 個編輯，否則 1 個），修正拼寫錯誤（例：`kubernets`→`kubernetes`、`compresion`→`compression`）。已可精確命中者不觸發，避免雜訊。
- **向後相容**：單詞查詢維持原有分層（name 完全命中 > name 子字串 > type > observation），行為不變。

## 多工作區支援

預設情況下，伺服器從**當前工作目錄**（`process.cwd()`）向上搜尋 `.aim`/`.git`/`package.json` 標記來自動偵測專案。這適用於單一專案的 MCP 用戶端。

部分 IDE（如 **Windsurf**）行為不同：

- MCP 伺服器以**全域方式配置**（`~/.codeium/windsurf/mcp_config.json`），**單一伺服器實例跨所有工作區共享**
- 伺服器從**任意工作目錄啟動**，該目錄不是專案根目錄，因此 `process.cwd()` 自動偵測無法識別當前工作區

在這些環境中按專案儲存記憶，需傳入 **`projectRoot`** 參數（當前工作區的絕對路徑）。伺服器會將記憶儲存於 `<projectRoot>/.aim/`，不受自身工作目錄影響：

```json
// 儲存至當前工作區的 .aim/ 目錄
aim_memory_store({
  projectRoot: "/Users/you/dev/my-project",
  entities: [{
    name: "AuthService",
    entityType: "module",
    observations: ["Handles JWT refresh"]
  }]
})

// 列出特定工作區的資料庫
aim_memory_list_stores({ projectRoot: "/Users/you/dev/my-project" })
```

**驗證規則：** `projectRoot` 必須是已存在的絕對路徑目錄。相對路徑或不存在的路徑會被拒絕，以避免歧義並防止在非預期位置建立散落的 `.aim` 目錄。`context` 值仍會經過路徑穿越驗證，確保 `<projectRoot>/.aim/memory-<context>.jsonl` 永遠不會逃離工作區的 `.aim` 目錄。

## Workspace-only 嚴格模式（強制隔離）

若你的目標是「記憶**只能**存在當前 workspace 的 `.aim/`、且**不讀寫全域**」，啟用 `--workspace-only`（或環境變數 `AIM_WORKSPACE_ONLY=true`）。啟用後：

- **強制 `projectRoot`**：每次工具呼叫都必須帶 `projectRoot`，缺少即報錯（fail-closed），絕不默默寫入全域。
- **停用全域**：`location:"global"` 被拒絕，也不再有全域 fallback。
- **讀取隔離**：`aim_memory_list_stores` 只列出本 workspace 的資料庫，`global_databases` 一律為空。
- **schema 提示**：`tools/list` 會把 `projectRoot` 標記為每個工具的必填欄位。

> ⚠️ 前提：Windsurf 目前**不支援 MCP `roots`**、MCP 設定為全域單一實例、且不注入 workspace 路徑，因此伺服器無法自行得知當前 workspace。嚴格模式透過「強制由 client 傳入 `projectRoot`」達成隔離，需搭配下方規則指示 Cascade 一律帶上當前 workspace 絕對路徑。

### 在 Windsurf 掛載

完成上方「安裝（本地 git clone）」後，Windsurf → **Settings > Tools > Windsurf Settings > Add Server → View Raw Config**，加入以下設定（設定檔官方為 `~/.codeium/mcp_config.json`，部分版本為 `~/.codeium/windsurf/mcp_config.json`；用 View Raw Config 最保險）。記得將 `args` 第一項換成你實際的 `dist/index.js` 絕對路徑：

```json
{
  "mcpServers": {
    "aim-memory": {
      "command": "node",
      "args": [
        "/absolute/path/to/knowledge-graph-mcp/dist/index.js",
        "--workspace-only"
      ]
    }
  }
}
```

存檔後按 **Refresh**。（嚴格模式下無需 `--memory-path`，不使用全域目錄。）

### 讓 Cascade 一律帶 projectRoot（全域規則）

在 Windsurf 的全域規則，或每個專案的 `.windsurf/rules/` 中加入：

> 呼叫任何 `aim_memory_*` 工具時，一律傳入 `projectRoot` 參數，其值為當前 workspace 的絕對根目錄路徑。若不確定，先確認工作區根目錄再呼叫。

如此可確保記憶穩定落在 `<workspace>/.aim/`，達成跨 workspace 的隔離記憶。

## 資料庫探索

使用 `aim_memory_list_stores` 查看所有可用資料庫：

```json
{
  "project_databases": [
    "default",      // 主資料庫（workspace 本地）
    "project-work"  // 命名資料庫
  ],
  "global_databases": [],
  "current_location": "project (.aim directory detected)"
}
```

**重點：**

- **"default"** = 主資料庫
- **current_location** 顯示當前 workspace 的 `.aim` 儲存位置
- **global_databases 恆為空** — 嚴格模式不使用全域儲存
- **命名資料庫** 是按主題組織的可選附加項

## 配置範例（自動核准讀取）

在 workspace-only 配置上加入 `autoapprove`，讓讀取類工具免確認：

```json
{
  "mcpServers": {
    "aim-memory": {
      "command": "node",
      "args": [
        "/absolute/path/to/knowledge-graph-mcp/dist/index.js",
        "--workspace-only"
      ],
      "autoapprove": [
        "aim_memory_search",
        "aim_memory_get",
        "aim_memory_read_all",
        "aim_memory_list_stores",
        "aim_memory_doctor",
        "aim_memory_list_entity_types"
      ]
    }
  }
}
```

## 疑難排解

### 「File does not contain required _aim safety marker」錯誤

- 該檔案可能不屬於本系統
- 手動建立的 JSONL 檔案需以 `{"type":"_aim","source":"mcp-knowledge-graph"}` 作為第一行
- 若手動建立了檔案，請加入 `_aim` 標記或刪除後讓系統重新建立

### 記憶儲存至非預期位置

- 確認 Cascade 呼叫時帶了正確的 `projectRoot`（當前 workspace 絕對路徑）
- 使用 `aim_memory_list_stores`（帶 `projectRoot`）查看該 workspace 的資料庫與位置
- 使用 `ls <workspace>/.aim/` 查看記憶檔案
- 缺少 `projectRoot` 會直接報錯，不會誤寫其他位置

### 過多相似資料庫

- AI 模型會嘗試使用一致的名稱，但可能產生變體
- 如需要可手動刪除不需要的資料庫檔案
- 鼓勵 AI 使用簡單、一致的資料庫名稱
- **提醒**：主資料庫永遠作為預設可用 — 命名資料庫是可選的

## 授權

MIT
