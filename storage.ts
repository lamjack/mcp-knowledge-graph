// 儲存/領域層：路徑安全檢查、記憶檔案解析、知識圖譜資料模型與所有持久化操作。

import { promises as fs } from 'fs';
import { existsSync, statSync } from 'fs';
import path, { isAbsolute } from 'path';
import { baseMemoryPath, FILE_MARKER, workspaceOnly as configWorkspaceOnly } from './config.js';

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
  const projectMarkers = ['.aim', '.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'];
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

// 依據 context 與可選的 location 覆蓋取得記憶檔案路徑。
// 匯出供測試使用：驗證多工作區 projectRoot 路由。
export function getMemoryFilePath(context?: string, location?: 'project' | 'global', projectRoot?: string, workspaceOnly: boolean = configWorkspaceOnly): string {
  // 在 context 被插入檔名之前驗證，確保穿越攻擊載荷永遠無法到達 path.join。
  if (context !== undefined) {
    assertContextSafe(context);
  }
  const filename = context ? `memory-${context}.jsonl` : 'memory.jsonl';

  // Workspace-only 嚴格模式：強制帶 projectRoot、停用全域儲存，記憶僅限
  // <projectRoot>/.aim/。缺 projectRoot 或指定 global 一律 fail-closed。
  if (workspaceOnly) {
    if (location === 'global') {
      throw new Error('Workspace-only mode: global storage is disabled. Remove location:"global".');
    }
    if (projectRoot === undefined) {
      throw new Error('Workspace-only mode: projectRoot is required. Pass the current workspace absolute path as projectRoot.');
    }
  }

  // 明確的 project root 優先於所有其他解析策略。這是多工作區路徑：
  // 用戶端傳入當前工作區根目錄，記憶儲存於 <projectRoot>/.aim/，
  // 不受伺服器 cwd 影響。
  if (projectRoot !== undefined) {
    assertProjectRootSafe(projectRoot);
    const aimDir = path.join(projectRoot, '.aim');
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
      const aimDir = path.join(detectedRoot, '.aim');
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
    const aimDir = path.join(detectedRoot, '.aim');
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
export interface SearchOptions {
  limit?: number | undefined;
  depth?: number | undefined;
}

// 關係的唯一鍵：以 NUL 分隔 from/relationType/to，避免值中含分隔字元造成碰撞。
// 用於以 Set 做 O(1) 的關係去重與刪除，取代嵌套線性掃描。
function relationKey(r: Relation): string {
  return `${r.from}\u0000${r.relationType}\u0000${r.to}`;
}

// 是否為「詞字元」（unicode 字母或數字）。底線與空白/標點皆視為詞邊界，
// 因此 snake_case 的各段會被當成獨立詞（與 JS \b 的差異：\b 視底線為詞字元）。
function isWordChar(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch);
}

// 判斷 term 是否以「整詞」形式出現在 haystack（兩側為字串邊界或非詞字元）。
// 用於搜尋的 word-boundary 權重：整詞命中優先於中段子字串命中。兩者皆為小寫。
function includesWholeWord(haystack: string, term: string): boolean {
  if (term.length === 0) return false;
  let idx = haystack.indexOf(term);
  while (idx !== -1) {
    const before = idx === 0 ? '' : haystack[idx - 1]!;
    const afterIdx = idx + term.length;
    const after = afterIdx >= haystack.length ? '' : haystack[afterIdx]!;
    const boundaryBefore = before === '' || !isWordChar(before);
    const boundaryAfter = after === '' || !isWordChar(after);
    if (boundaryBefore && boundaryAfter) return true;
    idx = haystack.indexOf(term, idx + 1);
  }
  return false;
}

// 以非詞字元切分為 token（unicode 友善）。用於查詢分詞，以及 fuzzy 比對時將實體文字 token 化。
function tokenizeWords(s: string): string[] {
  return s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// 受限編輯距離（Levenshtein）：一旦確定距離 > max 即提早回傳 max+1，避免不必要的計算。
// 用於 typo 容忍的近似比對（僅在查詢詞無精確命中時作為 fallback 觸發）。
function boundedLevenshtein(a: string, b: string, max: number): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    const curr = new Array<number>(lb + 1);
    curr[0] = i;
    let rowMin = curr[0];
    const ai = a[i - 1];
    for (let j = 1; j <= lb; j++) {
      const cost = ai === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  const d = prev[lb]!;
  return d <= max ? d : max + 1;
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
    for (const line of lines.slice(1)) {
      let item: any;
      try {
        item = JSON.parse(line);
      } catch {
        console.error('Skipping malformed line while loading knowledge graph.');
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

  async createEntities(entities: Entity[], context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<Entity[]> {
    const filePath = this.resolvePath(context, location, projectRoot);
    return this.runExclusive(filePath, async () => {
      const graph = await this.loadGraph(filePath);
      // O(N+k) 去重：先建現有名稱 Set，取代 filter 內嵌套 .some 的 O(k·N)。
      const existingNames = new Set(graph.entities.map(e => e.name));
      const newEntities = entities.filter(e => !existingNames.has(e.name));
      graph.entities.push(...newEntities);
      await this.saveGraph(graph, filePath);
      return newEntities;
    });
  }

  async createRelations(relations: Relation[], context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<Relation[]> {
    const filePath = this.resolvePath(context, location, projectRoot);
    return this.runExclusive(filePath, async () => {
      const graph = await this.loadGraph(filePath);
      // O(R+k) 去重：以關係鍵 Set 取代 filter 內嵌套 .some 的 O(k·R)。
      const existingKeys = new Set(graph.relations.map(relationKey));
      const newRelations = relations.filter(r => !existingKeys.has(relationKey(r)));
      graph.relations.push(...newRelations);
      await this.saveGraph(graph, filePath);
      return newRelations;
    });
  }

  async addObservations(observations: { entityName: string; contents: string[] }[], context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<{ entityName: string; addedObservations: string[] }[]> {
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
        const existing = new Set(entity.observations);
        const newObservations = o.contents.filter(content => !existing.has(content));
        entity.observations.push(...newObservations);
        return { entityName: o.entityName, addedObservations: newObservations };
      });
      await this.saveGraph(graph, filePath);
      return results;
    });
  }

  async deleteEntities(entityNames: string[], context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<void> {
    const filePath = this.resolvePath(context, location, projectRoot);
    return this.runExclusive(filePath, async () => {
      const graph = await this.loadGraph(filePath);
      // Set 成員判斷：O(N+R+D) 取代 Array.includes 內嵌於 filter 的 O((N+R)·D)。
      const toDelete = new Set(entityNames);
      graph.entities = graph.entities.filter(e => !toDelete.has(e.name));
      graph.relations = graph.relations.filter(r => !toDelete.has(r.from) && !toDelete.has(r.to));
      await this.saveGraph(graph, filePath);
    });
  }

  async deleteObservations(deletions: { entityName: string; observations: string[] }[], context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<void> {
    const filePath = this.resolvePath(context, location, projectRoot);
    return this.runExclusive(filePath, async () => {
      const graph = await this.loadGraph(filePath);
      const byName = new Map(graph.entities.map(e => [e.name, e] as const));
      deletions.forEach(d => {
        const entity = byName.get(d.entityName);
        if (entity) {
          const toRemove = new Set(d.observations);
          entity.observations = entity.observations.filter(o => !toRemove.has(o));
        }
      });
      await this.saveGraph(graph, filePath);
    });
  }

  async deleteRelations(relations: Relation[], context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<void> {
    const filePath = this.resolvePath(context, location, projectRoot);
    return this.runExclusive(filePath, async () => {
      const graph = await this.loadGraph(filePath);
      // O(R+D) 刪除：以關係鍵 Set 取代 filter 內嵌套 .some 的 O(R·D)。
      const toDelete = new Set(relations.map(relationKey));
      graph.relations = graph.relations.filter(r => !toDelete.has(relationKey(r)));
      await this.saveGraph(graph, filePath);
    });
  }

  async readGraph(context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<KnowledgeGraph> {
    return this.loadGraph(this.resolvePath(context, location, projectRoot));
  }

  // 相關性排序搜尋 + ego-graph 擴展。
  // 1) 對每個實體評分（name 完全命中 > name 子字串 > type 子字串 > observation 命中）；
  //    多詞查詢額外以 IDF 加權（降權通用詞、升權稀有詞）並對 observation 命中做長度正規化。
  // 2) 依分數排序取 top-k（limit）作為 seeds。
  // 3) 由 seeds 依 depth 跳數擴展鄰居（預設 1），讓命中的關係與脈絡不被丟棄。
  // 回傳的實體以「seeds（相關性序）在前、鄰居（名稱序）在後」排列，關係僅保留兩端皆在結果集者。
  async searchNodes(query: string, context?: string, location?: 'project' | 'global', projectRoot?: string, options?: SearchOptions): Promise<KnowledgeGraph> {
    const graph = await this.loadGraphShared(this.resolvePath(context, location, projectRoot));
    const qFull = query.toLowerCase();
    // 分詞：以非詞字元切分（unicode 友善）並去重。單詞查詢維持原有分層契約；
    // 多詞查詢額外啟用逐詞比對 + 詞覆蓋 + 整詞（word-boundary）權重 + IDF 加權，提升 recall 與精準度。
    const terms = Array.from(new Set(tokenizeWords(qFull)));

    // 預先小寫化各欄位一次（供 DF 統計與評分共用，避免每個實體重複轉換）。
    const docs = graph.entities.map(e => ({
      e,
      name: e.name.toLowerCase(),
      type: e.entityType.toLowerCase(),
      obs: e.observations.map(o => o.toLowerCase()),
    }));
    const N = docs.length;

    // Document frequency：每個 term 出現於多少實體（name/type/任一 obs 含該子字串）。
    // 供 IDF 與 fuzzy 門檻共用。
    const df = new Map<string, number>();
    for (const t of terms) {
      let c = 0;
      for (const d of docs) {
        if (d.name.includes(t) || d.type.includes(t) || d.obs.some(o => o.includes(t))) c++;
      }
      df.set(t, c);
    }

    // IDF：add-one 平滑（idf = 1 + ln((N+1)/(df+1))，恆 >= 1）：稀有詞被放大、通用詞回歸基準 1。
    // 單一 term 對所有實體是等倍率、不改變相對排序，故僅在多詞查詢時套用。
    const idf = new Map<string, number>();
    if (terms.length >= 2) {
      for (const t of terms) idf.set(t, 1 + Math.log((N + 1) / ((df.get(t) ?? 0) + 1)));
    }

    // Fuzzy fallback（typo 容忍）：僅對「語料中無任何精確子字串命中（df=0）」且長度 >= 4 的 term 啟用，
    // 避免對已可精確命中者引入雜訊，並把昂貴的編輯距離限制在真的需要時才計算。
    const FUZZY_MIN_LEN = 4;
    const fuzzyTerms = terms.filter(t => t.length >= FUZZY_MIN_LEN && (df.get(t) ?? 0) === 0);
    const needFuzzy = fuzzyTerms.length > 0;
    // 需要時才把各實體文字切成 token 集（name + type + observations），供近似比對。
    const docTokens: Set<string>[] = needFuzzy
      ? docs.map(d => {
          const toks = new Set<string>();
          for (const w of tokenizeWords(d.name)) toks.add(w);
          for (const w of tokenizeWords(d.type)) toks.add(w);
          for (const o of d.obs) for (const w of tokenizeWords(o)) toks.add(w);
          return toks;
        })
      : [];

    const scoreOf = (d: { name: string; type: string; obs: string[] }, i: number): number => {
      const { name, type, obs } = d;
      // 長度正規化：observation 越多的實體，單則命中的邊際貢獻越低，抑制長 hub 靠「數量」霸榜。
      // <=1 則 observation 時係數為 1（不影響短實體），observation 越多係數越小。
      const obsNorm = 1 / (1 + Math.log(1 + Math.max(0, obs.length - 1)));

      let score = 0;
      // 片語層（整條查詢當單一子字串）：完整保留單詞查詢的既有分層（100/10/5/1）。
      if (name === qFull) score += 100;
      else if (name.includes(qFull)) score += 10;
      if (type.includes(qFull)) score += 5;
      let phraseObsHits = 0;
      for (const o of obs) if (o.includes(qFull)) phraseObsHits++;
      score += phraseObsHits * obsNorm;

      // 多詞增益：僅當 >=2 詞時啟用（單詞查詢行為與排序完全不變）。逐詞貢獻以 IDF 加權。
      if (terms.length >= 2) {
        let matchedTerms = 0;
        for (const t of terms) {
          let contribution = 0;
          if (name.includes(t)) contribution += includesWholeWord(name, t) ? 10 : 5;
          if (type.includes(t)) contribution += includesWholeWord(type, t) ? 4 : 2;
          let obsHit = 0;
          for (const o of obs) {
            if (o.includes(t)) obsHit += includesWholeWord(o, t) ? 1 : 0.5;
          }
          contribution += obsHit * obsNorm;
          if (contribution > 0) matchedTerms++;
          score += contribution * (idf.get(t) ?? 1);
        }
        // 詞覆蓋獎勵：命中越多不同查詢詞越相關，讓多詞命中者排在單詞命中者之上。
        if (matchedTerms >= 2) score += matchedTerms * 3;
      }

      // Fuzzy fallback：對 df=0 的長 term，若實體有 token 落在小編輯距離內給溫和加分（補 typo/近似）。
      // 距離門檻依 term 長度（>=7 允許 2 個編輯，否則 1 個），並以長度差先行剪枝。
      if (needFuzzy) {
        const toks = docTokens[i]!;
        for (const t of fuzzyTerms) {
          const maxEdits = t.length >= 7 ? 2 : 1;
          for (const tok of toks) {
            if (Math.abs(tok.length - t.length) > maxEdits) continue;
            if (boundedLevenshtein(tok, t, maxEdits) <= maxEdits) {
              score += 4;
              break;
            }
          }
        }
      }
      return score;
    };

    // seeds：命中（score > 0）者依分數遞減排序，同分以名稱穩定排序。
    const scored = docs
      .map((d, i) => ({ e: d.e, score: scoreOf(d, i) }))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name));

    // 正規化來自 client 的數值輸入（可能是浮點、負數、NaN 或 Infinity）。
    // limit：有限數 → 取下限 0 的整數（負值視為 0，回空結果）；其餘（未提供/NaN/Infinity）→ 不設上限。
    const rawLimit = options?.limit;
    const limit = (typeof rawLimit === 'number' && Number.isFinite(rawLimit)) ? Math.max(0, Math.floor(rawLimit)) : undefined;
    const seeds = (limit !== undefined) ? scored.slice(0, limit) : scored;
    const seedNames = seeds.map(s => s.e.name);
    const seedSet = new Set(seedNames);

    // ego-graph 擴展：由 seeds 出發，逐層（BFS）納入 depth 跳內的鄰居。
    // depth：有限數 → 取下限 0 的整數；其餘（未提供/NaN/Infinity）→ 預設 1。
    const rawDepth = options?.depth;
    const depth = (typeof rawDepth === 'number' && Number.isFinite(rawDepth)) ? Math.max(0, Math.floor(rawDepth)) : 1;
    // 鄰接表：每跳只走前沿節點的邊（O(觸及邊數）），取代每跳掃全部關係的 O(depth·R)。
    const adjacency = new Map<string, string[]>();
    const addAdj = (a: string, b: string) => {
      const list = adjacency.get(a);
      if (list) list.push(b);
      else adjacency.set(a, [b]);
    };
    for (const r of graph.relations) {
      addAdj(r.from, r.to);
      addAdj(r.to, r.from);
    }
    const included = new Set<string>(seedNames);
    let frontier: string[] = seedNames;
    for (let d = 0; d < depth; d++) {
      const next: string[] = [];
      for (const node of frontier) {
        const neighbours = adjacency.get(node);
        if (!neighbours) continue;
        for (const nb of neighbours) {
          if (!included.has(nb)) {
            included.add(nb);
            next.push(nb);
          }
        }
      }
      if (next.length === 0) break;
      frontier = next;
    }

    // 組裝實體：seeds（相關性序）在前，鄰居（名稱序）在後。
    const byName = new Map(graph.entities.map(e => [e.name, e] as const));
    const neighbourNames = [...included].filter(n => !seedSet.has(n)).sort((a, b) => a.localeCompare(b));
    const entities: Entity[] = [];
    for (const n of seedNames) {
      const e = byName.get(n);
      if (e) entities.push(e);
    }
    for (const n of neighbourNames) {
      const e = byName.get(n);
      if (e) entities.push(e);
    }

    // 關係：僅保留兩端皆在結果集者（此時已因擴展而連貫）。
    const relations = graph.relations.filter(r => included.has(r.from) && included.has(r.to));

    // 因使用共享快取參考，需深拷貝回傳的子圖，避免呼叫端透過回傳值污染快取。
    return structuredClone({ entities, relations });
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

  async listDatabases(projectRoot?: string): Promise<{ project_databases: string[], global_databases: string[], current_location: string }> {
    const result = {
      project_databases: [] as string[],
      global_databases: [] as string[],
      current_location: ""
    };

    // Workspace-only 嚴格模式：強制帶 projectRoot、僅列本 workspace，永不觸及全域。
    if (this.workspaceOnly) {
      if (projectRoot === undefined) {
        throw new Error('Workspace-only mode: projectRoot is required. Pass the current workspace absolute path as projectRoot.');
      }
      assertProjectRootSafe(projectRoot);
      const aimDir = path.join(projectRoot, '.aim');
      if (existsSync(aimDir)) {
        result.current_location = `workspace-only (${aimDir})`;
        try {
          const files = await fs.readdir(aimDir);
          result.project_databases = files
            .filter(file => file.endsWith('.jsonl'))
            .map(file => file === 'memory.jsonl' ? 'default' : file.replace('memory-', '').replace('.jsonl', ''))
            .sort();
        } catch (error) {
          // 目錄存在但無法讀取 — 忽略
        }
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
      const aimDir = path.join(detectedRoot, '.aim');
      if (existsSync(aimDir)) {
        result.current_location = "project (.aim directory detected)";
        try {
          const files = await fs.readdir(aimDir);
          result.project_databases = files
            .filter(file => file.endsWith('.jsonl'))
            .map(file => file === 'memory.jsonl' ? 'default' : file.replace('memory-', '').replace('.jsonl', ''))
            .sort();
        } catch (error) {
          // 目錄存在但無法讀取 — 忽略
        }
      } else {
        result.current_location = "global (no .aim directory in project)";
      }
    } else {
      result.current_location = "global (no project detected)";
    }

    // 檢查全域目錄
    try {
      const files = await fs.readdir(baseMemoryPath);
      result.global_databases = files
        .filter(file => file.endsWith('.jsonl'))
        .map(file => file === 'memory.jsonl' ? 'default' : file.replace('memory-', '').replace('.jsonl', ''))
        .sort();
    } catch (error) {
      // 目錄不存在或無法讀取
      result.global_databases = [];
    }

    return result;
  }
}

export const knowledgeGraphManager = new KnowledgeGraphManager();
