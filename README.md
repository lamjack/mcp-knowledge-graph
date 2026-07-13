# MCP Knowledge Graph

**透過本地知識圖譜為 AI 模型提供持久記憶的 MCP 伺服器。**

使用實體（entities）、關係（relations）與觀察（observations）跨對話儲存和擷取資訊。支援任何 MCP 相容的 AI 平台。

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

**專案本地儲存：** 目錄必須命名為 `.aim`，置於專案根目錄，例如 `my-project/.aim/memory.jsonl`。

**全域儲存（`--memory-path`）：** 可使用任意目錄，例如 `~/.aim/`、`~/memories/`、`~/Dropbox/ai-memory/`。

### 主資料庫概念

主資料庫（master database）是預設的記憶儲存，未指定資料庫時一律使用它。在列表中顯示為 `default`，檔案名為 `memory.jsonl`。

- **預設行為**：所有記憶操作預設使用主資料庫
- **隨處可用**：專案本地與全域位置皆存在
- **主要儲存**：跨所有對話持久化的主要知識圖譜
- **命名資料庫**：可選的額外資料庫（`work`、`personal`、`health`），按主題組織

## 本地開發環境設定

### 先決條件

- Node.js 22+
- MCP 相容的 AI 平台

### 建置與測試

```bash
npm install        # 安裝依賴
npm run build      # 編譯 TypeScript
npm test           # 執行測試
```

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

| 檔案 | 用途 |
|------|------|
| `config.ts` | CLI 參數解析、基底記憶路徑、檔案標記定義 |
| `storage.ts` | 路徑安全檢查、記憶檔案解析、知識圖譜資料模型與持久化操作 |
| `tools.ts` | MCP 工具 schema 定義 |
| `server.ts` | 伺服器實例、請求處理器與 `main()` 進入點 |
| `index.ts` | 套件進入點（bin target），匯入並啟動 `server.ts` |

### 儲存邏輯

**檔案位置優先順序：**

1. **專案含 `.aim` 目錄** — 使用 `.aim/memory.jsonl`（專案本地）
2. **無專案或無 `.aim`** — 使用設定的全域目錄
3. **指定 context** — 加後綴：`memory-work.jsonl`、`memory-personal.jsonl`

**安全系統：**

- 每個記憶檔案以 `{"type":"_aim","source":"mcp-knowledge-graph"}` 開頭
- 系統拒絕寫入不含此標記的檔案
- 防止誤覆寫無關的 JSONL 檔案

## 使用方式

### 全域記憶（推薦）

在 MCP 配置檔中加入以下設定。兩種常見做法：

**選項一：預設 `.aim` 目錄（簡單）**

```json
{
  "mcpServers": {
    "Aim-Memory-Bank": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-knowledge-graph",
        "--memory-path",
        "/Users/yourusername/.aim"
      ]
    }
  }
}
```

**選項二：雲端同步目錄（跨機可攜）**

使用同步資料夾在多台機器間共享記憶：

```json
{
  "mcpServers": {
    "Aim-Memory-Bank": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-knowledge-graph",
        "--memory-path",
        "/Users/yourusername/Dropbox/ai-memory"
      ]
    }
  }
}
```

這會在指定目錄建立記憶檔案：

- `memory.jsonl` — **主資料庫**（預設操作）
- `memory-work.jsonl` — 工作資料庫
- `memory-personal.jsonl` — 個人資料庫

### 專案本地記憶

在任何專案中建立 `.aim` 目錄：

```bash
mkdir .aim
```

此後記憶工具自動使用 `.aim/memory.jsonl`（專案本地主資料庫），而非全域儲存。

### AI 如何使用資料庫

AI 模型預設使用主資料庫，也可透過 `context` 參數指定命名資料庫。新資料庫自動建立，無需額外設定：

```json
// 主資料庫（預設，無需 context）
aim_memory_store({
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

// 指定位置的主資料庫
aim_memory_store({
  location: "global",
  entities: [{
    name: "Important_Info",
    entityType: "reference",
    observations: ["Stored in global master database"]
  }]
})
```

### 檔案組織

**全域設定：**

```tree
/Users/yourusername/.aim/
├── memory.jsonl           # 主資料庫（預設）
├── memory-work.jsonl      # 工作資料庫
├── memory-personal.jsonl  # 個人資料庫
└── memory-health.jsonl    # 健康資料庫
```

**專案設定：**

```tree
my-project/
├── .aim/
│   ├── memory.jsonl       # 專案主資料庫（預設）
│   └── memory-work.jsonl  # 專案工作資料庫
└── src/
```

## 可用工具

- `aim_memory_store` — 儲存新記憶（人物、專案、概念）
- `aim_memory_add_facts` — 向既有記憶新增事實
- `aim_memory_link` — 連結兩個記憶
- `aim_memory_search` — 依關鍵字搜尋記憶
- `aim_memory_get` — 依確切名稱擷取特定記憶
- `aim_memory_read_all` — 讀取資料庫中所有記憶
- `aim_memory_list_stores` — 列出可用資料庫
- `aim_memory_forget` — 遺忘記憶
- `aim_memory_remove_facts` — 移除記憶中的特定事實
- `aim_memory_unlink` — 移除記憶之間的連結

### 參數

- `context`（可選）— 指定命名資料庫（`work`、`personal` 等）。預設為主資料庫
- `location`（可選）— 強制使用 `project` 或 `global` 儲存位置。預設為自動偵測
- `projectRoot`（可選）— 當前工作區/專案根目錄的絕對路徑。設定後記憶儲存於 `<projectRoot>/.aim/`，覆蓋自動偵測。多工作區 IDE 必須使用（見下文）

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

**替代方案（不使用 `projectRoot`）：** 若希望按專案隔離但不傳入路徑，可在 `mcp_config.json` 中為每個專案新增獨立的伺服器設定，各自指定 `--memory-path`。此方式需手動設定且每個專案會載入重複的工具集。

## 資料庫探索

使用 `aim_memory_list_stores` 查看所有可用資料庫：

```json
{
  "project_databases": [
    "default",      // 主資料庫（專案本地）
    "project-work"  // 命名資料庫
  ],
  "global_databases": [
    "default",      // 主資料庫（全域）
    "work",
    "personal",
    "health"
  ],
  "current_location": "project (.aim directory detected)"
}
```

**重點：**

- **"default"** = 兩個位置的主資料庫
- **current_location** 顯示目前使用專案或全域儲存
- **主資料庫隨處存在** — 它是主要記憶儲存
- **命名資料庫** 是按主題組織的可選附加項

## 配置範例

**重要：** 務必指定 `--memory-path` 以控制記憶檔案的儲存位置。

**自動核准讀取操作（推薦）：**

```json
{
  "mcpServers": {
    "Aim-Memory-Bank": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-knowledge-graph",
        "--memory-path",
        "/Users/yourusername/.aim"
      ],
      "autoapprove": [
        "aim_memory_search",
        "aim_memory_get",
        "aim_memory_read_all",
        "aim_memory_list_stores"
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

- 檢查是否在含 `.aim` 目錄的專案中（會使用專案本地儲存）
- 否則使用設定的全域 `--memory-path` 目錄
- 使用 `aim_memory_list_stores` 查看所有可用資料庫與當前位置
- 使用 `ls .aim/` 或 `ls ~/.aim/` 查看記憶檔案

### 過多相似資料庫

- AI 模型會嘗試使用一致的名稱，但可能產生變體
- 如需要可手動刪除不需要的資料庫檔案
- 鼓勵 AI 使用簡單、一致的資料庫名稱
- **提醒**：主資料庫永遠作為預設可用 — 命名資料庫是可選的

## 授權

MIT
