// 儲存/領域層：路徑安全檢查、記憶檔案解析、知識圖譜資料模型與所有持久化操作。

import { promises as fs } from 'fs';
import { existsSync, statSync } from 'fs';
import path, { isAbsolute } from 'path';
import { baseMemoryPath, FILE_MARKER, workspaceOnly as configWorkspaceOnly, AIM_DIR_NAME, DB_FILE_EXT, DB_FILE_PREFIX, MASTER_DB_FILE } from './config.js';
import { recordDiagnostic } from './diagnostics.js';
import { searchGraph, type SearchOptions } from './search.js';
import { auditGraph, excerptOf, keyHeadOf, normalizeTypeKey, type DoctorReport } from './audit.js';

// `context` 值的允許格式。context 會被插入檔名
// （`memory-${context}.jsonl`），因此絕不能包含路徑分隔符或目錄穿越段。
// context 是簡短識別碼，不是路徑。
const CONTEXT_PATTERN = /^[A-Za-z0-9_.-]+$/;

// 拒絕格式錯誤或能逃離目標目錄的 context。
// 第一道防線（CWE-22 路徑穿越），在值被插入檔名之前執行。
export function assertContextSafe(context: string): void {
  if (typeof context !== 'string' || context.length === 0) {
    throw new Error('Invalid context: must be a non-empty string');
  }
  // 明確拒絕穿越/分隔符（與允許清單構成縱深防禦，並為常見情況提供更明確的錯誤訊息）。
  if (context === '.' || context === '..' || context.includes('/') || context.includes('\\')) {
    throw new Error('Invalid context: must not contain path separators or traversal segments');
  }
  if (!CONTEXT_PATTERN.test(context)) {
    throw new Error('Invalid context: only letters, digits, "_", "-", and "." are allowed');
  }
}

// 包含檢查：解析後的目標路徑必須位於 baseDir 內。使用
// path.relative 確保對 `..`、絕對路徑與跨平台分隔符差異具有強健性。
export function assertInScope(targetPath: string, baseDir: string): void {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  const rel = path.relative(resolvedBase, resolvedTarget);
  if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || isAbsolute(rel)) {
    throw new Error('Resolved memory path escapes the configured storage directory');
  }
}

// 驗證呼叫端傳入的 project root。在多工作區 IDE（如 Windsurf）中，
// 伺服器的 process.cwd() 不是工作區，因此用戶端需明確傳入工作區根目錄。
// 我們要求已存在的絕對路徑目錄：相對路徑在無可靠 cwd 時有歧義，
// 拒絕不存在的路徑可防止幻覺/拼字錯誤的路徑透過 mkdir 在檔案系統中散落 `.aim` 目錄。
export function assertProjectRootSafe(projectRoot: string): void {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new Error('Invalid projectRoot: must be a non-empty string');
  }
  if (!isAbsolute(projectRoot)) {
    throw new Error('Invalid projectRoot: must be an absolute path');
  }
  let stats;
  try {
    stats = statSync(projectRoot);
  } catch {
    throw new Error('Invalid projectRoot: directory does not exist');
  }
  if (!stats.isDirectory()) {
    throw new Error('Invalid projectRoot: path is not a directory');
  }
}

// 專案偵測 — 搜尋常見的專案標記。
// .aim 優先檢查：若存在，即為專案本地儲存的明確信號。
export function findProjectRoot(startDir: string = process.cwd()): string | null {
  const projectMarkers = [AIM_DIR_NAME, '.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'];
  let currentDir = startDir;
  const maxDepth = 5;

  for (let i = 0; i < maxDepth; i++) {
    // 檢查專案標記
    for (const marker of projectMarkers) {
      if (existsSync(path.join(currentDir, marker))) {
        return currentDir;
      }
    }

    // 向上移動一層目錄
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      // 已到達根目錄
      break;
    }
    currentDir = parentDir;
  }

  return null;
}

// database 名 ↔ JSONL 檔名的單一編/解碼點：master 為 memory.jsonl（對外名 'default'），
// 具名 context 為 memory-<context>.jsonl。集中於此，避免檔名 scheme 散落多處（見 config 的 DB_FILE_* 常量）。
function dbFileName(context?: string): string {
  return context ? `${DB_FILE_PREFIX}${context}${DB_FILE_EXT}` : MASTER_DB_FILE;
}

// 由 JSONL 檔名還原對外資料庫名（master → 'default'），與 dbFileName 互為逆運算。
function dbNameFromFile(file: string): string {
  return file === MASTER_DB_FILE ? 'default' : file.replace(DB_FILE_PREFIX, '').replace(DB_FILE_EXT, '');
}

// 列出某目錄下所有 JSONL 資料庫的對外名稱（排序）。目錄不存在或無法讀取時回空陣列，
// 與三個呼叫點原先各自「讀取失敗即視為無資料庫」的 try/catch 行為一致。
async function readDatabaseNames(dir: string): Promise<string[]> {
  try {
    const files = await fs.readdir(dir);
    return files.filter(f => f.endsWith(DB_FILE_EXT)).map(dbNameFromFile).sort();
  } catch {
    return [];
  }
}

// Workspace-only 模式下缺 projectRoot 的拒絕訊息（單一真相）。
// 匯出的原因是診斷資訊分屬兩層：本層只收到解析後的 projectRoot，結構上不可能知道
// 呼叫端「實際送來哪些鍵」；server 層才拿得到原始 arguments，故由它在此句之後補上
// 鍵清單與 payload 字節數（見 server.ts argsDiagnostic）。共用同一常量避免兩處訊息漂移。
export const PROJECT_ROOT_REQUIRED_MESSAGE =
  'Workspace-only mode: projectRoot is required. Pass the current workspace absolute path as projectRoot.';

// 依據 context 與可選的 location 覆蓋取得記憶檔案路徑。
// 匯出供測試使用：驗證多工作區 projectRoot 路由。
export function getMemoryFilePath(context?: string, location?: 'project' | 'global', projectRoot?: string, workspaceOnly: boolean = configWorkspaceOnly): string {
  // 在 context 被插入檔名之前驗證，確保穿越攻擊載荷永遠無法到達 path.join。
  if (context !== undefined) {
    assertContextSafe(context);
  }
  const filename = dbFileName(context);

  // Workspace-only 嚴格模式：強制帶 projectRoot、停用全域儲存，記憶僅限
  // <projectRoot>/.aim/。缺 projectRoot 或指定 global 一律 fail-closed。
  if (workspaceOnly) {
    if (location === 'global') {
      throw new Error('Workspace-only mode: global storage is disabled. Remove location:"global".');
    }
    if (projectRoot === undefined) {
      throw new Error(PROJECT_ROOT_REQUIRED_MESSAGE);
    }
  }

  // 明確的 project root 優先於所有其他解析策略。這是多工作區路徑：
  // 用戶端傳入當前工作區根目錄，記憶儲存於 <projectRoot>/.aim/，
  // 不受伺服器 cwd 影響。
  if (projectRoot !== undefined) {
    assertProjectRootSafe(projectRoot);
    const aimDir = path.join(projectRoot, AIM_DIR_NAME);
    const candidate = path.join(aimDir, filename);
    assertInScope(candidate, aimDir);
    return candidate;
  }

  // 若明確指定了 location，則使用它
  if (location === 'global') {
    const candidate = path.join(baseMemoryPath, filename);
    assertInScope(candidate, baseMemoryPath);
    return candidate;
  }

  if (location === 'project') {
    const detectedRoot = findProjectRoot();
    if (detectedRoot) {
      const aimDir = path.join(detectedRoot, AIM_DIR_NAME);
      const candidate = path.join(aimDir, filename); // 若 .aim 不存在則會建立
      assertInScope(candidate, aimDir);
      return candidate;
    } else {
      throw new Error('No project detected - cannot use project location');
    }
  }

  // 自動偵測邏輯（既有行為）
  const detectedRoot = findProjectRoot();
  if (detectedRoot) {
    const aimDir = path.join(detectedRoot, AIM_DIR_NAME);
    if (existsSync(aimDir)) {
      const candidate = path.join(aimDir, filename);
      assertInScope(candidate, aimDir);
      return candidate;
    }
  }

  // 回退至設定的基底目錄
  const candidate = path.join(baseMemoryPath, filename);
  assertInScope(candidate, baseMemoryPath);
  return candidate;
}

// 我們以圖譜結構儲存記憶，使用實體、關係與觀察
export interface Entity {
  name: string;
  entityType: string;
  observations: string[];
}

export interface Relation {
  from: string;
  to: string;
  relationType: string;
}

export interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
}

// createEntities 的回傳：新建立的實體 + entityType 格式治理警告（不阻斷寫入）。
export interface CreateEntitiesResult {
  entities: Entity[];
  warnings: string[];
}

// deleteObservations 的單一刪除目標：observations（逐字精確）與 observationPrefix（前綴）
// 恰擇一且非空。前綴模式是 prune 的自然表達（「刪掉前綴 session <ts>｜ 的全部 observation」），
// 避免長 / CJK 字串逐字比對失敗造成的靜默 no-op。
export interface DeleteObservationsEntry {
  entityName: string;
  observations?: string[] | undefined;
  observationPrefix?: string | undefined;
}

// 每個 entity 的刪除回報：任何情況都能分辨「全刪 / 部分刪 / 一條沒刪 / entity 不存在」。
// requested：要求刪除的項目數（exact 模式為去重後字串數、前綴模式為 1）；
// removed：實際刪除的 observation 數；
// unmatched：未命中的要求（exact 為未命中的字串、前綴 0 命中時回顯該前綴）。
export interface DeleteObservationsResult {
  entityName: string;
  entityExists: boolean;
  requested: number;
  removed: number;
  unmatched: string[];
}

// countObservations 的 per-entity 唯讀回報（不回 observation 本文）。groups 僅在提供
// groupByDelimiter 時存在：key 為命中 observation 開頭到首個分隔符（含）的片段；
// 命中但不含分隔符者以全文為 key。
export interface ObservationCountResult {
  entityName: string;
  entityExists: boolean;
  totalObservations: number;
  matched: number;
  groups?: { key: string; count: number }[] | undefined;
}

// 判斷 `line` 是否為我們的 `_aim` 安全標記。永不拋出例外（無效 JSON -> false）。
function isMarkerLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line);
    return parsed.type === FILE_MARKER.type && parsed.source === FILE_MARKER.source;
  } catch {
    return false;
  }
}

// 將知識圖譜格式化為人類可讀文字
export function formatGraphPretty(graph: KnowledgeGraph, context?: string): string {
  const lines: string[] = [];
  const dbName = context || 'default';

  lines.push(`=== ${dbName} database ===`);
  lines.push('');

  // 實體區段
  if (graph.entities.length === 0) {
    lines.push('ENTITIES: (none)');
  } else {
    lines.push(`ENTITIES (${graph.entities.length}):`);
    for (const entity of graph.entities) {
      lines.push(`  ${entity.name} [${entity.entityType}]`);
      for (const obs of entity.observations) {
        lines.push(`    - ${obs}`);
      }
    }
  }

  lines.push('');

  // 關係區段
  if (graph.relations.length === 0) {
    lines.push('RELATIONS: (none)');
  } else {
    lines.push(`RELATIONS (${graph.relations.length}):`);
    for (const rel of graph.relations) {
      lines.push(`  ${rel.from} --${rel.relationType}--> ${rel.to}`);
    }
  }

  return lines.join('\n');
}

// Token 精簡序列化：每個實體壓成單行（observations 以 " | " 串接），
// 每個關係一行。相較 pretty/JSON 大幅減少換行與縮排，適合塞進大模型 context。
export function formatGraphConcise(graph: KnowledgeGraph, context?: string): string {
  const dbName = context || 'default';
  const lines: string[] = [`=== ${dbName} database (concise) ===`];

  lines.push(`ENTITIES (${graph.entities.length}):`);
  for (const e of graph.entities) {
    const head = `- ${e.name} (${e.entityType})`;
    lines.push(e.observations.length > 0 ? `${head}: ${e.observations.join(' | ')}` : head);
  }

  lines.push(`RELATIONS (${graph.relations.length}):`);
  for (const r of graph.relations) {
    lines.push(`- ${r.from} -[${r.relationType}]-> ${r.to}`);
  }

  return lines.join('\n');
}

// 搜尋選項：limit 限制 seed 命中數量，depth 控制 ego-graph 擴展跳數。
// 明確允許 undefined，讓呼叫端可直接透傳未提供的工具參數（exactOptionalPropertyTypes）。
// 關係的唯一鍵：以 NUL 分隔 from/relationType/to，避免值中含分隔字元造成碰撞。
// 用於以 Set 做 O(1) 的關係去重與刪除，取代嵌套線性掃描。
function relationKey(r: Relation): string {
  return `${r.from}\u0000${r.relationType}\u0000${r.to}`;
}

// 由「既有型別集合 + 本次新增實體」偵測 entityType 格式碰撞警告：新型別與某既有型別
// 正規化後相同、但原字串不同時，回傳一則提醒（不阻斷寫入）。同批內首次出現的新型別
// 會被納入已知集合，避免對同批後續相同型別誤報。
function detectEntityTypeWarnings(existingTypes: Iterable<string>, newEntities: Entity[]): string[] {
  const known = new Map<string, string>();
  for (const t of existingTypes) {
    const k = normalizeTypeKey(t);
    if (!known.has(k)) known.set(k, t);
  }
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const e of newEntities) {
    const k = normalizeTypeKey(e.entityType);
    const existing = known.get(k);
    if (existing === undefined) {
      // 本批內首次出現此正規化型別 -> 納入 known，讓同批後續同型別不誤報。
      known.set(k, e.entityType);
    } else if (existing !== e.entityType) {
      const dedupeKey = `${e.entityType}\u0000${existing}`;
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        warnings.push(`entityType '${e.entityType}' 與既有 '${existing}' 僅差格式，是否應統一？`);
      }
    }
  }
  return warnings;
}

// KnowledgeGraphManager 類別包含所有與知識圖譜互動的操作
export class KnowledgeGraphManager {
  // Workspace-only 嚴格模式旗標。預設取自執行時配置，可由建構子覆寫（供測試）。
  private readonly workspaceOnly: boolean;

  constructor(workspaceOnly: boolean = configWorkspaceOnly) {
    this.workspaceOnly = workspaceOnly;
  }

  // 每個檔案的 Promise 鏈。將同一檔案的讀取-修改-寫入操作序列化，
  // 避免並發工具呼叫遺失彼此的更新。這很重要，因為單一伺服器行程跨工作區共享。
  private writeChains = new Map<string, Promise<unknown>>();

  // 已解析圖譜的讀取快取，以 mtime + size 作失效判斷。純效能優化：
  // 任何不一致都退回重新讀檔並重新解析。快取存放權威的已解析圖譜：loadGraphShared 直接
  // 回傳其參考（呼叫端不得修改）；mutation 與整圖讀取用 loadGraph 取得深拷貝，search/get 只深拷貝回傳的子圖。
  // 以 nanosecond 精度的 mtime（bigint）搭配 size 為鍵，將「同一時間戳 + 同 size 却內容不同」
  // 的碰撞窗口從毫秒級壓到先秒級（取決於檔案系統解析度），進一步降低讀到陳舊資料的風險。
  private graphCache = new Map<string, { mtimeNs: bigint; size: bigint; graph: KnowledgeGraph }>();

  private runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.writeChains.get(key) ?? Promise.resolve();
    // 無論前一個任務是 resolve 還是 reject 都執行。
    const run = prev.then(task, task);
    // 保持鏈存活但吞掉結算結果，確保單次失敗不會鎖死整個鏈。
    const settled = run.then(() => undefined, () => undefined);
    this.writeChains.set(key, settled);
    // 鏈閒置後清理該 key，避免長生命週期、跨工作區的伺服器無限累積條目。
    // 僅在期間沒有新任務接上（仍是同一個 settled）時才刪除，確保並發安全。
    void settled.then(() => {
      if (this.writeChains.get(key) === settled) {
        this.writeChains.delete(key);
      }
    });
    return run;
  }

  // 依當前嚴格模式解析單一記憶檔案路徑（含 workspace-only 驗證）。
  // 每個公開操作只解析一次，避免同一次操作重複執行 statSync 與路徑驗證。
  private resolvePath(context?: string, location?: 'project' | 'global', projectRoot?: string): string {
    return getMemoryFilePath(context, location, projectRoot, this.workspaceOnly);
  }

  // 讀取共享的已解析圖譜（唯讀）。回傳物件可能與快取共用參考，呼叫端「絕不可」修改；
  // 需要可安全修改的副本時使用 loadGraph（會深拷貝）。內部唯讀路徑（search/get）用此版本，
  // 只對最終回傳的子圖做深拷貝，避免整圖 clone 的成本。
  private async loadGraphShared(filePath: string): Promise<KnowledgeGraph> {
    let stat;
    try {
      stat = await fs.stat(filePath, { bigint: true });
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as any).code === "ENOENT") {
        // 檔案不存在 — 首次儲存時會建立含 metadata 的檔案。清除任何過期快取。
        this.graphCache.delete(filePath);
        return { entities: [], relations: [] };
      }
      throw error;
    }

    // 快取命中：以 nanosecond mtime + size 同時驗證。回傳快取的共享參考（唯讀）。
    const cached = this.graphCache.get(filePath);
    if (cached && cached.mtimeNs === stat.mtimeNs && cached.size === stat.size) {
      return cached.graph;
    }

    const data = await fs.readFile(filePath, "utf-8");
    const lines = data.split("\n").filter(line => line.trim() !== "");

    if (lines.length === 0) {
      const empty: KnowledgeGraph = { entities: [], relations: [] };
      this.graphCache.set(filePath, { mtimeNs: stat.mtimeNs, size: stat.size, graph: empty });
      return empty;
    }

    // 檢查第一行是否為我們的檔案標記
    if (!isMarkerLine(lines[0]!)) {
      // 不回顯解析後的絕對路徑：這會向呼叫端洩漏設定的基底目錄。保持訊息通用。
      throw new Error('Target file does not contain the required _aim safety marker. It may not belong to the knowledge graph system.');
    }

    // 處理剩餘行（跳過 metadata）。容忍損壞的行而非中止整個讀取。
    const graph: KnowledgeGraph = { entities: [], relations: [] };
    for (const [offset, line] of lines.slice(1).entries()) {
      let item: any;
      try {
        item = JSON.parse(line);
      } catch {
        // 跳過的行會被排除在記憶體圖譜之外，而下一次任何寫入都以 saveGraph 整檔重寫
        // → 該筆資料就此永久消失。因此這裡必須留下足以人工救回的線索：
        // 檔案、1-based 行號（標記為第 1 行）、以及內容摘錄。
        // 走 recordDiagnostic 與工具拒絕路徑共用檔案 sink——stderr 不可依賴
        // （實測某些客戶端產生的 server 行程 FD2 直接指向 /dev/null）。
        recordDiagnostic(
          'skipping malformed line while loading knowledge graph',
          `file=${filePath}; line ${offset + 2}; content: ${excerptOf(line)}`,
        );
        continue;
      }
      if (item.type === "entity") graph.entities.push(item as Entity);
      if (item.type === "relation") graph.relations.push(item as Relation);
    }

    // 存入快取（權威參考）並回傳同一參考；唯讀呼叫端不得修改。
    this.graphCache.set(filePath, { mtimeNs: stat.mtimeNs, size: stat.size, graph });
    return graph;
  }

  // 讀取一份可安全修改的圖譜副本。所有 mutation 路徑與需要回傳整張圖的讀取（readGraph）使用此版本。
  private async loadGraph(filePath: string): Promise<KnowledgeGraph> {
    return structuredClone(await this.loadGraphShared(filePath));
  }

  // 縱深防禦：拒絕覆寫不屬於本系統的既有檔案。
  // loadGraph 已在讀取路徑強制此檢查，但 saveGraph 獨立守護，
  // 確保未來的直接呼叫者無法覆寫無關檔案。
  private async assertExistingIsOurs(filePath: string): Promise<void> {
    let data: string;
    try {
      data = await fs.readFile(filePath, "utf-8");
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as any).code === "ENOENT") {
        return; // 新檔案 — 無需保護。
      }
      throw error;
    }
    const firstLine = data.split("\n").find(line => line.trim() !== "");
    if (firstLine !== undefined && !isMarkerLine(firstLine)) {
      throw new Error('Target file does not contain the required _aim safety marker. It may not belong to the knowledge graph system.');
    }
  }

  private async saveGraph(graph: KnowledgeGraph, filePath: string): Promise<void> {
    const lines = [
      JSON.stringify(FILE_MARKER),
      ...graph.entities.map(e => JSON.stringify({ type: "entity", ...e })),
      ...graph.relations.map(r => JSON.stringify({ type: "relation", ...r })),
    ];

    // 確保目錄存在
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    // 絕不覆寫非標記檔案。
    await this.assertExistingIsOurs(filePath);

    // 原子寫入：先寫入同目錄的暫存檔，再 rename。
    // rename() 在同一檔案系統上是原子操作，因此寫入中途崩潰永遠不會
    // 留下截斷/損壞的記憶檔案。
    const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
    try {
      await fs.writeFile(tmpPath, lines.join("\n"));
      await fs.rename(tmpPath, filePath);
    } catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw error;
    }

    // 寫入成功後刷新快取，讓後續讀取免於重新解析；stat 失敗則使該快取失效。
    try {
      const stat = await fs.stat(filePath, { bigint: true });
      this.graphCache.set(filePath, { mtimeNs: stat.mtimeNs, size: stat.size, graph: structuredClone(graph) });
    } catch {
      this.graphCache.delete(filePath);
    }
  }

  // 回傳新建立的實體與 entityType 格式治理警告。警告不阻斷寫入（向後相容：呼叫端可忽略 warnings）。
  async createEntities(entities: Entity[], context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<CreateEntitiesResult> {
    const filePath = this.resolvePath(context, location, projectRoot);
    return this.runExclusive(filePath, async () => {
      const graph = await this.loadGraph(filePath);
      // O(N+k) 去重：先建現有名稱 Set，取代 filter 內嵌套 .some 的 O(k·N)。
      const existingNames = new Set(graph.entities.map(e => e.name));
      const newEntities = entities.filter(e => !existingNames.has(e.name));
      // 只對「真正新建立」的實體比對既有型別，避免對被去重忽略的重複實體誤報。
      const warnings = detectEntityTypeWarnings(graph.entities.map(e => e.entityType), newEntities);
      // 實體已存在時本方法從不覆蓋，其 observations 會被整批丟棄。過去這是**靜默**的：
      // 回傳空陣列，呼叫端看起來像成功寫入，事實卻從未落地——舊事實因而繼續被當成現況召回。
      // 這裡如實回報丟棄量並指向真正該用的工具（與 remove_facts / replace_fact 的無靜默失敗一致）。
      for (const e of entities) {
        if (existingNames.has(e.name) && e.observations.length > 0) {
          warnings.push(
            `Entity "${e.name}" already exists: ${e.observations.length} observation(s) were NOT written. ` +
            `aim_memory_store never overwrites - use aim_memory_add_facts to append, ` +
            `or add_facts with upsertKeyed / aim_memory_replace_fact to supersede a keyed fact.`,
          );
        }
      }
      if (newEntities.length === 0) {
        // 沒有真正新增就不寫檔（比照 replaceFact / removeFacts 的 0 命中不觸碰 mtime）。
        return { entities: newEntities, warnings };
      }
      graph.entities.push(...newEntities);
      await this.saveGraph(graph, filePath);
      return { entities: newEntities, warnings };
    });
  }

  // 建立關係。預設對不存在的端點 fail-closed（防幽靈節點），錯誤列出所有缺失端點且不寫檔；
  // 傳 allowDangling:true 作為逃生門可還原舊行為（允許懸空邊）。
  async createRelations(relations: Relation[], context?: string, location?: 'project' | 'global', projectRoot?: string, allowDangling: boolean = false): Promise<Relation[]> {
    const filePath = this.resolvePath(context, location, projectRoot);
    return this.runExclusive(filePath, async () => {
      const graph = await this.loadGraph(filePath);
      if (!allowDangling) {
        const names = new Set(graph.entities.map(e => e.name));
        const missing = new Set<string>();
        for (const r of relations) {
          if (!names.has(r.from)) missing.add(r.from);
          if (!names.has(r.to)) missing.add(r.to);
        }
        if (missing.size > 0) {
          throw new Error(
            `Cannot create relation(s): endpoint entities do not exist: ${[...missing].sort().join(', ')}. ` +
            `Create them first, or pass allowDangling:true to override.`,
          );
        }
      }
      // O(R+k) 去重：以關係鍵 Set 取代 filter 內嵌套 .some 的 O(k·R)。
      const existingKeys = new Set(graph.relations.map(relationKey));
      const newRelations = relations.filter(r => !existingKeys.has(relationKey(r)));
      // 全重複就不寫檔（比照 createEntities 的 0 新增不觸碰 mtime）。
      if (newRelations.length === 0) return newRelations;
      graph.relations.push(...newRelations);
      await this.saveGraph(graph, filePath);
      return newRelations;
    });
  }

  // 預設為純追加（去重）。entry 帶 upsertKeyed 時，該 entry 中形如 `key: value` 的內容
  // 改為「同鍵覆蓋」：先刪掉該 entity 上同 key 頭的既有 observation 再追加新值，使一個狀態槽
  // 永遠只有一條當前值。刻意 opt-in——service: a / service: b 這類合法多值鍵在自動覆蓋下
  // 會被清空，正確性不能靠猜。無 key 頭的內容不受影響，照常追加。
  async addObservations(observations: { entityName: string; contents: string[]; upsertKeyed?: boolean | undefined }[], context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<{ entityName: string; addedObservations: string[]; replacedObservations?: string[] }[]> {
    const filePath = this.resolvePath(context, location, projectRoot);
    return this.runExclusive(filePath, async () => {
      const graph = await this.loadGraph(filePath);
      // name → entity 索引，避免每個 target 都 .find 全表（O(t·N) → O(N+t)）。
      const byName = new Map(graph.entities.map(e => [e.name, e] as const));
      const results = observations.map(o => {
        const entity = byName.get(o.entityName);
        if (!entity) {
          throw new Error(`Entity with name ${o.entityName} not found`);
        }
        if (!o.upsertKeyed) {
          const existing = new Set(entity.observations);
          const newObservations = o.contents.filter(content => !existing.has(content));
          entity.observations.push(...newObservations);
          return { entityName: o.entityName, addedObservations: newObservations };
        }
        // 本 entry 的所有 key 頭先收齊，再一次過濾，讓同批寫入互不干擾。
        const incomingKeys = new Set<string>();
        for (const content of o.contents) {
          const head = keyHeadOf(content);
          if (head !== undefined) incomingKeys.add(head);
        }
        const incoming = new Set(o.contents);
        const replacedObservations = entity.observations.filter(existing => {
          const head = keyHeadOf(existing);
          // 逐字相同者不算「被取代」——它就是要寫的那條，留著即可（回報 0 新增 0 取代）。
          return head !== undefined && incomingKeys.has(head) && !incoming.has(existing);
        });
        const replaced = new Set(replacedObservations);
        const kept = entity.observations.filter(existing => !replaced.has(existing));
        const stillPresent = new Set(kept);
        const newObservations = o.contents.filter(content => !stillPresent.has(content));
        entity.observations = [...kept, ...newObservations];
        return { entityName: o.entityName, addedObservations: newObservations, replacedObservations };
      });
      // 整批 0 新增且 0 取代就不寫檔（比照 deleteObservations 的 0 刪除不觸碰 mtime）。
      const changed = results.some(
        r => r.addedObservations.length > 0 || (r.replacedObservations?.length ?? 0) > 0,
      );
      if (changed) await this.saveGraph(graph, filePath);
      return results;
    });
  }

  async deleteEntities(entityNames: string[], context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<void> {
    const filePath = this.resolvePath(context, location, projectRoot);
    return this.runExclusive(filePath, async () => {
      const graph = await this.loadGraph(filePath);
      // Set 成員判斷：O(N+R+D) 取代 Array.includes 內嵌於 filter 的 O((N+R)·D)。
      const toDelete = new Set(entityNames);
      const keptEntities = graph.entities.filter(e => !toDelete.has(e.name));
      const keptRelations = graph.relations.filter(r => !toDelete.has(r.from) && !toDelete.has(r.to));
      // 0 命中（無該實體、連帶也無關係可刪）就不寫檔（比照 createEntities 的 0 新增不觸碰 mtime）。
      if (keptEntities.length === graph.entities.length && keptRelations.length === graph.relations.length) return;
      graph.entities = keptEntities;
      graph.relations = keptRelations;
      await this.saveGraph(graph, filePath);
    });
  }

  // 刪除 observation 並如實回報每個 entity 的結果（消滅靜默失敗：entity 不存在或
  // 0 命中都明確可辨，不再無差別回「成功」）。每個 entry 的 observations（逐字精確）
  // 與 observationPrefix（前綴整批）恰擇一且非空；全部 entry 先驗證再碰圖譜，
  // 無效呼叫不產生部分寫入。整批一條都沒刪成時不寫檔（比照 replaceFact 不觸碰 mtime）。
  async deleteObservations(deletions: DeleteObservationsEntry[], context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<DeleteObservationsResult[]> {
    type DeleteSpec =
      | { kind: 'exact'; entityName: string; requested: string[]; toRemove: Set<string> }
      | { kind: 'prefix'; entityName: string; prefix: string };
    const specs: DeleteSpec[] = deletions.map(d => {
      const hasExact = d.observations !== undefined && d.observations.length > 0;
      const hasPrefix = d.observationPrefix !== undefined && d.observationPrefix !== '';
      if (hasExact === hasPrefix) {
        throw new Error(`deleteObservations requires exactly one of observations or observationPrefix per entry (entity "${d.entityName}")`);
      }
      if (hasPrefix) {
        return { kind: 'prefix', entityName: d.entityName, prefix: d.observationPrefix! };
      }
      const requested = [...new Set(d.observations!)];
      return { kind: 'exact', entityName: d.entityName, requested, toRemove: new Set(requested) };
    });

    const filePath = this.resolvePath(context, location, projectRoot);
    return this.runExclusive(filePath, async () => {
      const graph = await this.loadGraph(filePath);
      const byName = new Map(graph.entities.map(e => [e.name, e] as const));
      let totalRemoved = 0;
      const results: DeleteObservationsResult[] = specs.map(spec => {
        const requestedCount = spec.kind === 'exact' ? spec.requested.length : 1;
        const entity = byName.get(spec.entityName);
        if (!entity) {
          return {
            entityName: spec.entityName,
            entityExists: false,
            requested: requestedCount,
            removed: 0,
            unmatched: spec.kind === 'exact' ? [...spec.requested] : [spec.prefix],
          };
        }
        const present = new Set(entity.observations);
        const kept = spec.kind === 'exact'
          ? entity.observations.filter(o => !spec.toRemove.has(o))
          : entity.observations.filter(o => !o.startsWith(spec.prefix));
        const removed = entity.observations.length - kept.length;
        totalRemoved += removed;
        if (removed > 0) entity.observations = kept;
        const unmatched = spec.kind === 'exact'
          ? spec.requested.filter(s => !present.has(s))
          : removed === 0 ? [spec.prefix] : [];
        return { entityName: spec.entityName, entityExists: true, requested: requestedCount, removed, unmatched };
      });
      if (totalRemoved > 0) {
        await this.saveGraph(graph, filePath);
      }
      return results;
    });
  }

  // 唯讀前綴計數：回傳每個 entity 的 observation 總數與前綴命中數，可選以
  // groupByDelimiter 分組（key＝開頭到首個分隔符（含）的片段）。不回 observation 本文，
  // 讓「entity 內某前綴有幾個分組、各自 key 是什麼」不需全量拉取即可回答
  // （SessionLog prune 的決策依據）。entity 不存在時如實回報 entityExists:false。
  async countObservations(names: string[], observationPrefix: string, groupByDelimiter?: string, context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<ObservationCountResult[]> {
    if (typeof observationPrefix !== 'string' || observationPrefix === '') {
      throw new Error('countObservations requires a non-empty observationPrefix');
    }
    const delimiter = groupByDelimiter !== undefined && groupByDelimiter !== '' ? groupByDelimiter : undefined;
    const graph = await this.loadGraphShared(this.resolvePath(context, location, projectRoot));
    const byName = new Map(graph.entities.map(e => [e.name, e] as const));
    return names.map(name => {
      const entity = byName.get(name);
      if (!entity) {
        return {
          entityName: name,
          entityExists: false,
          totalObservations: 0,
          matched: 0,
          groups: delimiter !== undefined ? [] : undefined,
        };
      }
      const hits = entity.observations.filter(o => o.startsWith(observationPrefix));
      let groups: { key: string; count: number }[] | undefined;
      if (delimiter !== undefined) {
        const counts = new Map<string, number>();
        for (const o of hits) {
          const idx = o.indexOf(delimiter);
          const key = idx >= 0 ? o.slice(0, idx + delimiter.length) : o;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        groups = [...counts.entries()]
          .map(([key, count]) => ({ key, count }))
          .sort((a, b) => a.key.localeCompare(b.key));
      }
      return {
        entityName: name,
        entityExists: true,
        totalObservations: entity.observations.length,
        matched: hits.length,
        groups,
      };
    });
  }

  async deleteRelations(relations: Relation[], context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<void> {
    const filePath = this.resolvePath(context, location, projectRoot);
    return this.runExclusive(filePath, async () => {
      const graph = await this.loadGraph(filePath);
      // O(R+D) 刪除：以關係鍵 Set 取代 filter 內嵌套 .some 的 O(R·D)。
      const toDelete = new Set(relations.map(relationKey));
      const kept = graph.relations.filter(r => !toDelete.has(relationKey(r)));
      // 0 命中就不寫檔（比照 deleteObservations 的 0 刪除不觸碰 mtime）。
      if (kept.length === graph.relations.length) return;
      graph.relations = kept;
      await this.saveGraph(graph, filePath);
    });
  }

  async readGraph(context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<KnowledgeGraph> {
    return this.loadGraph(this.resolvePath(context, location, projectRoot));
  }

  // 相關性排序搜尋 + ego-graph 擴展。引擎已抽至 search.ts 的 searchGraph（純函式模組，
  // 評分/擴展的語義註釋隨引擎一併搬遷）；此方法只做路徑解析與共享快取讀取，行為不變。
  async searchNodes(query: string, context?: string, location?: 'project' | 'global', projectRoot?: string, options?: SearchOptions): Promise<KnowledgeGraph> {
    const graph = await this.loadGraphShared(this.resolvePath(context, location, projectRoot));
    return searchGraph(graph, query, options);
  }

  async openNodes(names: string[], context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<KnowledgeGraph> {
    const graph = await this.loadGraphShared(this.resolvePath(context, location, projectRoot));

    // 以 Set 加速名稱比對（O(N) 取代 O(N·|names|)）
    const wanted = new Set(names);
    const filteredEntities = graph.entities.filter(e => wanted.has(e.name));

    // 建立已篩選實體名稱的 Set 以便快速查詢
    const filteredEntityNames = new Set(filteredEntities.map(e => e.name));

    // 篩選關係，僅保留已篩選實體之間的關係
    const filteredRelations = graph.relations.filter(r =>
      filteredEntityNames.has(r.from) && filteredEntityNames.has(r.to)
    );

    // 因使用共享快取參考，需深拷貝回傳的子圖，避免呼叫端透過回傳值污染快取。
    return structuredClone({ entities: filteredEntities, relations: filteredRelations });
  }

  // 原地更新實體：可改名與/或改 entityType，保留 observations（順序不變）。
  // 改名時連帶更新所有 relation 的 from/to 端點；目標名已存在則報錯不覆蓋。
  async updateEntity(name: string, changes: { newName?: string | undefined; entityType?: string | undefined }, context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<Entity> {
    const newName = changes.newName;
    const entityType = changes.entityType;
    const wantsRename = newName !== undefined && newName !== '';
    const wantsRetype = entityType !== undefined && entityType !== '';
    if (!wantsRename && !wantsRetype) {
      throw new Error('updateEntity requires at least one of newName or entityType');
    }
    const filePath = this.resolvePath(context, location, projectRoot);
    return this.runExclusive(filePath, async () => {
      const graph = await this.loadGraph(filePath);
      const entity = graph.entities.find(e => e.name === name);
      if (!entity) {
        throw new Error(`Entity with name ${name} not found`);
      }
      // 僅在確實改成不同名稱時才重寫端點；改成自身視為無操作。
      if (wantsRename && newName !== name) {
        if (graph.entities.some(e => e.name === newName)) {
          throw new Error(`Cannot rename to ${newName}: an entity with that name already exists`);
        }
        entity.name = newName!;
        for (const r of graph.relations) {
          if (r.from === name) r.from = newName!;
          if (r.to === name) r.to = newName!;
        }
      }
      if (wantsRetype) {
        entity.entityType = entityType!;
      }
      await this.saveGraph(graph, filePath);
      return entity;
    });
  }

  // 原子「刪舊補新」：刪除某實體所有命中（matchPrefix 或 matchSubstring 二擇一）的 observation，
  // 再追加 newText（同一寫入完成）。0 命中則不追加並回傳 matched:0（防靜默 no-op）。
  async replaceFact(entityName: string, match: { prefix?: string | undefined; substring?: string | undefined; exact?: string | undefined }, newText: string, context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<{ matched: number; replaced: boolean }> {
    const hasPrefix = match.prefix !== undefined && match.prefix !== '';
    const hasSubstring = match.substring !== undefined && match.substring !== '';
    // exact 是「把這段原文換成那段」——呼叫端最自然的意圖。實測診斷紀錄裡 6 筆
    // replace_fact 失敗全是在表達這個語義（oldFact / oldObservation），而工具當時只有
    // prefix/substring：拿 substring 硬代替會過度命中（「狀態: 好」會連「狀態: 好極了」一起刪），
    // 所以這是能力缺口而非命名問題，必須補上而不是靠 alias 硬湊。
    const hasExact = match.exact !== undefined && match.exact !== '';
    const modes = [hasPrefix, hasSubstring, hasExact].filter(Boolean).length;
    if (modes !== 1) {
      throw new Error('replaceFact requires exactly one of matchPrefix, matchSubstring or matchExact');
    }
    const predicate = hasExact
      ? (o: string) => o === match.exact!
      : hasPrefix
        ? (o: string) => o.startsWith(match.prefix!)
        : (o: string) => o.includes(match.substring!);

    const filePath = this.resolvePath(context, location, projectRoot);
    return this.runExclusive(filePath, async () => {
      const graph = await this.loadGraph(filePath);
      const entity = graph.entities.find(e => e.name === entityName);
      if (!entity) {
        throw new Error(`Entity with name ${entityName} not found`);
      }
      const kept = entity.observations.filter(o => !predicate(o));
      const matched = entity.observations.length - kept.length;
      // 0 命中：不追加、不寫檔（避免無謂觸碰 mtime），明確回報以防靜默 no-op。
      if (matched === 0) {
        return { matched: 0, replaced: false };
      }
      // 追加新文字；若已存在於未命中者中則不重複，維持與 add_facts 一致的去重語義。
      if (!kept.includes(newText)) kept.push(newText);
      entity.observations = kept;
      await this.saveGraph(graph, filePath);
      return { matched, replaced: true };
    });
  }

  // 唯讀圖譜審計。引擎已抽至 audit.ts 的 auditGraph（純函式模組，各偵測區段的語義註釋
  // 隨引擎一併搬遷）；此方法只做路徑解析與共享快取讀取，行為不變。
  async doctor(context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<DoctorReport> {
    const graph = await this.loadGraphShared(this.resolvePath(context, location, projectRoot));
    return auditGraph(graph, context || 'default');
  }

  // 唯讀：回傳各 entityType 與其實體計數，數量多者在前（同數以名稱排序）。
  async listEntityTypes(context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<{ entityType: string; count: number }[]> {
    const graph = await this.loadGraphShared(this.resolvePath(context, location, projectRoot));
    const counts = new Map<string, number>();
    for (const e of graph.entities) {
      counts.set(e.entityType, (counts.get(e.entityType) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([entityType, count]) => ({ entityType, count }))
      .sort((a, b) => b.count - a.count || a.entityType.localeCompare(b.entityType));
  }

  async listDatabases(projectRoot?: string): Promise<{ project_databases: string[], global_databases: string[], current_location: string }> {
    const result = {
      project_databases: [] as string[],
      global_databases: [] as string[],
      current_location: ""
    };

    // Workspace-only 嚴格模式：強制帶 projectRoot、僅列本 workspace，永不觸及全域。
    if (this.workspaceOnly) {
      if (projectRoot === undefined) {
        throw new Error(PROJECT_ROOT_REQUIRED_MESSAGE);
      }
      assertProjectRootSafe(projectRoot);
      const aimDir = path.join(projectRoot, AIM_DIR_NAME);
      if (existsSync(aimDir)) {
        result.current_location = `workspace-only (${aimDir})`;
        result.project_databases = await readDatabaseNames(aimDir);
      } else {
        result.current_location = `workspace-only (no .aim directory yet in ${projectRoot})`;
      }
      // 全域資料庫在嚴格模式下一律不暴露。
      return result;
    }

    // 解析專案本地根目錄：明確的、呼叫端傳入的 projectRoot 優先
    // （多工作區），否則回退至基於 cwd 的自動偵測。
    let detectedRoot: string | null;
    if (projectRoot !== undefined) {
      assertProjectRootSafe(projectRoot);
      detectedRoot = projectRoot;
    } else {
      detectedRoot = findProjectRoot();
    }

    // 檢查專案本地 .aim 目錄
    if (detectedRoot) {
      const aimDir = path.join(detectedRoot, AIM_DIR_NAME);
      if (existsSync(aimDir)) {
        result.current_location = "project (.aim directory detected)";
        result.project_databases = await readDatabaseNames(aimDir);
      } else {
        result.current_location = "global (no .aim directory in project)";
      }
    } else {
      result.current_location = "global (no project detected)";
    }

    // 檢查全域目錄
    result.global_databases = await readDatabaseNames(baseMemoryPath);

    return result;
  }
}

export const knowledgeGraphManager = new KnowledgeGraphManager();
