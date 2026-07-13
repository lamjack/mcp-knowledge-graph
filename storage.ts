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

  private runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.writeChains.get(key) ?? Promise.resolve();
    // 無論前一個任務是 resolve 還是 reject 都執行。
    const run = prev.then(task, task);
    // 保持鏈存活但吞掉結算結果，確保單次失敗不會鎖死整個鏈。
    this.writeChains.set(key, run.then(() => undefined, () => undefined));
    return run;
  }

  private async loadGraph(context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<KnowledgeGraph> {
    const filePath = getMemoryFilePath(context, location, projectRoot, this.workspaceOnly);

    try {
      const data = await fs.readFile(filePath, "utf-8");
      const lines = data.split("\n").filter(line => line.trim() !== "");

      if (lines.length === 0) {
        return { entities: [], relations: [] };
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
      return graph;
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as any).code === "ENOENT") {
        // 檔案不存在 — 首次儲存時會建立含 metadata 的檔案
        return { entities: [], relations: [] };
      }
      throw error;
    }
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

  private async saveGraph(graph: KnowledgeGraph, context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<void> {
    const filePath = getMemoryFilePath(context, location, projectRoot, this.workspaceOnly);

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
  }

  async createEntities(entities: Entity[], context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<Entity[]> {
    const key = getMemoryFilePath(context, location, projectRoot, this.workspaceOnly);
    return this.runExclusive(key, async () => {
      const graph = await this.loadGraph(context, location, projectRoot);
      const newEntities = entities.filter(e => !graph.entities.some(existingEntity => existingEntity.name === e.name));
      graph.entities.push(...newEntities);
      await this.saveGraph(graph, context, location, projectRoot);
      return newEntities;
    });
  }

  async createRelations(relations: Relation[], context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<Relation[]> {
    const key = getMemoryFilePath(context, location, projectRoot, this.workspaceOnly);
    return this.runExclusive(key, async () => {
      const graph = await this.loadGraph(context, location, projectRoot);
      const newRelations = relations.filter(r => !graph.relations.some(existingRelation =>
        existingRelation.from === r.from &&
        existingRelation.to === r.to &&
        existingRelation.relationType === r.relationType
      ));
      graph.relations.push(...newRelations);
      await this.saveGraph(graph, context, location, projectRoot);
      return newRelations;
    });
  }

  async addObservations(observations: { entityName: string; contents: string[] }[], context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<{ entityName: string; addedObservations: string[] }[]> {
    const key = getMemoryFilePath(context, location, projectRoot, this.workspaceOnly);
    return this.runExclusive(key, async () => {
      const graph = await this.loadGraph(context, location, projectRoot);
      const results = observations.map(o => {
        const entity = graph.entities.find(e => e.name === o.entityName);
        if (!entity) {
          throw new Error(`Entity with name ${o.entityName} not found`);
        }
        const newObservations = o.contents.filter(content => !entity.observations.includes(content));
        entity.observations.push(...newObservations);
        return { entityName: o.entityName, addedObservations: newObservations };
      });
      await this.saveGraph(graph, context, location, projectRoot);
      return results;
    });
  }

  async deleteEntities(entityNames: string[], context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<void> {
    const key = getMemoryFilePath(context, location, projectRoot, this.workspaceOnly);
    return this.runExclusive(key, async () => {
      const graph = await this.loadGraph(context, location, projectRoot);
      graph.entities = graph.entities.filter(e => !entityNames.includes(e.name));
      graph.relations = graph.relations.filter(r => !entityNames.includes(r.from) && !entityNames.includes(r.to));
      await this.saveGraph(graph, context, location, projectRoot);
    });
  }

  async deleteObservations(deletions: { entityName: string; observations: string[] }[], context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<void> {
    const key = getMemoryFilePath(context, location, projectRoot, this.workspaceOnly);
    return this.runExclusive(key, async () => {
      const graph = await this.loadGraph(context, location, projectRoot);
      deletions.forEach(d => {
        const entity = graph.entities.find(e => e.name === d.entityName);
        if (entity) {
          entity.observations = entity.observations.filter(o => !d.observations.includes(o));
        }
      });
      await this.saveGraph(graph, context, location, projectRoot);
    });
  }

  async deleteRelations(relations: Relation[], context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<void> {
    const key = getMemoryFilePath(context, location, projectRoot, this.workspaceOnly);
    return this.runExclusive(key, async () => {
      const graph = await this.loadGraph(context, location, projectRoot);
      graph.relations = graph.relations.filter(r => !relations.some(delRelation =>
        r.from === delRelation.from &&
        r.to === delRelation.to &&
        r.relationType === delRelation.relationType
      ));
      await this.saveGraph(graph, context, location, projectRoot);
    });
  }

  async readGraph(context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<KnowledgeGraph> {
    return this.loadGraph(context, location, projectRoot);
  }

  // 非常基礎的搜尋函式
  async searchNodes(query: string, context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph(context, location, projectRoot);

    // 篩選實體
    const filteredEntities = graph.entities.filter(e =>
      e.name.toLowerCase().includes(query.toLowerCase()) ||
      e.entityType.toLowerCase().includes(query.toLowerCase()) ||
      e.observations.some(o => o.toLowerCase().includes(query.toLowerCase()))
    );

    // 建立已篩選實體名稱的 Set 以便快速查詢
    const filteredEntityNames = new Set(filteredEntities.map(e => e.name));

    // 篩選關係，僅保留已篩選實體之間的關係
    const filteredRelations = graph.relations.filter(r =>
      filteredEntityNames.has(r.from) && filteredEntityNames.has(r.to)
    );

    const filteredGraph: KnowledgeGraph = {
      entities: filteredEntities,
      relations: filteredRelations,
    };

    return filteredGraph;
  }

  async openNodes(names: string[], context?: string, location?: 'project' | 'global', projectRoot?: string): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph(context, location, projectRoot);

    // 篩選實體
    const filteredEntities = graph.entities.filter(e => names.includes(e.name));

    // 建立已篩選實體名稱的 Set 以便快速查詢
    const filteredEntityNames = new Set(filteredEntities.map(e => e.name));

    // 篩選關係，僅保留已篩選實體之間的關係
    const filteredRelations = graph.relations.filter(r =>
      filteredEntityNames.has(r.from) && filteredEntityNames.has(r.to)
    );

    const filteredGraph: KnowledgeGraph = {
      entities: filteredEntities,
      relations: filteredRelations,
    };

    return filteredGraph;
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
