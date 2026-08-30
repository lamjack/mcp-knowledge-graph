// MCP 伺服器接線：實例化 stdio 伺服器、註冊工具處理器，
// 並匯出 main() 供進入點使用。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";

import { fileURLToPath } from 'url';

import { pkg, maxOutputChars, workspaceOnly } from './config.js';
import { macauIsoTimestamp, recordDiagnostic } from './diagnostics.js';
import {
  knowledgeGraphManager,
  formatGraphPretty,
  formatGraphConcise,
  boundedLevenshtein,
  normalizeNonNegInt,
  findProjectRoot,
  PROJECT_ROOT_REQUIRED_MESSAGE,
  type KnowledgeGraph,
  type Entity,
  type Relation,
  type DeleteObservationsEntry,
} from './storage.js';
import { TOOL_DEFINITIONS, TOOL_NAME_ALIASES, PARAM_ALIASES } from './tools.js';

// 依 format 參數序列化圖譜。'concise' 為 token 精簡格式，'pretty' 為人類可讀，
// 其餘（含未指定）一律回退到結構化 JSON，維持既有預設行為。
function formatGraph(graph: KnowledgeGraph, format: unknown, context?: string): string {
  if (format === 'pretty') return formatGraphPretty(graph, context);
  if (format === 'concise') return formatGraphConcise(graph, context);
  return JSON.stringify(graph, null, 2);
}

// includeObservations 投影（server 層，不改動 storage API）：為 false 時剝除每個 entity 的
// observations（保留 name + entityType 與完整關係骨架），供審計/索引大圖時避免數百 KB 輸出被截斷。
// 未指定或 true 時原樣回傳（向後相容）。輸入圖譜來自 readGraph/openNodes 的深拷貝，就地投影安全。
export function projectObservations(graph: KnowledgeGraph, includeObservations: unknown): KnowledgeGraph {
  if (includeObservations === false) {
    return {
      entities: graph.entities.map(e => ({ name: e.name, entityType: e.entityType, observations: [] })),
      relations: graph.relations,
    };
  }
  return graph;
}

// aim_memory_get 的 observation 級過濾（server 層，不改動 storage 讀取 API）：
// observationPrefix 或 observationSubstring 恰擇一（並給報錯，走 isError 通道）。
// 啟動時每個 entity 只保留命中條目，並產生一行 [obs-filter] 抬頭報命中/總數；
// 0 命中的 entity 保留（空 observations），讓「無命中」可與「entity 不存在」分辨——
// 這正是刪除後核實落盤狀態所需的證據。未啟動過濾時原樣透傳（同一參考，向後相容）。
export function filterObservations(graph: KnowledgeGraph, rawPrefix: unknown, rawSubstring: unknown): { graph: KnowledgeGraph; header: string | null } {
  const prefix = typeof rawPrefix === 'string' && rawPrefix !== '' ? rawPrefix : undefined;
  const substring = typeof rawSubstring === 'string' && rawSubstring !== '' ? rawSubstring : undefined;
  if (prefix !== undefined && substring !== undefined) {
    throw new Error('aim_memory_get accepts at most one of observationPrefix or observationSubstring');
  }
  if (prefix === undefined && substring === undefined) return { graph, header: null };

  const predicate = prefix !== undefined
    ? (o: string) => o.startsWith(prefix)
    : (o: string) => o.includes(substring!);
  let total = 0;
  let matched = 0;
  let entitiesMatched = 0;
  const entities = graph.entities.map(e => {
    total += e.observations.length;
    const kept = e.observations.filter(predicate);
    matched += kept.length;
    if (kept.length > 0) entitiesMatched++;
    return { ...e, observations: kept };
  });
  const by = prefix !== undefined ? `prefix="${prefix}"` : `substring="${substring}"`;
  const header = `[obs-filter] ${by}: matched ${matched} of ${total} observations across ${entitiesMatched} of ${entities.length} entities`;
  return { graph: { entities, relations: graph.relations }, header };
}

// 分頁結果的中繼資訊。entity 是觀察值的載體（大圖體積的主要來源），故分頁作用於 entity 清單；
// relations 是廉價的骨架，每頁完整回傳，便於呼叫端在任一頁都能看到關係脈絡。
export interface PageInfo {
  offset: number;
  count: number;
  total: number;
  hasMore: boolean;
  nextOffset: number | null;
}

// read_all 的 entity 分頁：以 offset/limit 切片 entities，relations 原樣保留。
// 僅在確有分頁意圖（提供 limit，或 offset > 0）時啟用；否則回傳原圖且 pageInfo 為 null，
// 維持不帶分頁參數時的既有行為（含 JSON 輸出逐位元組相容）。
export function paginateGraph(graph: KnowledgeGraph, rawOffset: unknown, rawLimit: unknown): { graph: KnowledgeGraph; pageInfo: PageInfo | null } {
  const offset = normalizeNonNegInt(rawOffset) ?? 0;
  const limit = normalizeNonNegInt(rawLimit); // undefined = 不限筆數
  const active = limit !== undefined || offset > 0;
  if (!active) return { graph, pageInfo: null };

  const total = graph.entities.length;
  const end = limit === undefined ? total : Math.min(total, offset + limit);
  const entities = graph.entities.slice(offset, end);
  const hasMore = end < total;
  return {
    graph: { entities, relations: graph.relations },
    pageInfo: { offset, count: entities.length, total, hasMore, nextOffset: hasMore ? end : null },
  };
}

// 分頁抬頭：讓模型知道目前讀到哪段、是否還有更多、以及下一頁該用的 offset。
function pageHeader(p: PageInfo): string {
  const tail = p.hasMore ? ` — more available: call read_all again with offset=${p.nextOffset}` : ' — end of list';
  return `[page] entities ${p.offset}-${p.offset + p.count} of ${p.total}${tail}`;
}

// read_all 未帶分頁參數、格式化輸出仍超過 max 時的自動降級：以 entity 邊界切出能放進
// 預算的最大前綴作為「第一頁」（relations 骨架完整保留），前置 [page] 抬頭告知
// nextOffset，讓模型以 offset 逐頁續讀。輸出維持所選格式的完整性（json 仍可解析），
// 取代 capText 硬切造成的破損 JSON 與每輪召回必現的截斷提示。連第一個 entity 都放不
// 進預算時回傳 null，由呼叫端退回 capText 硬切作最後防線。
export function autoPaginateText(graph: KnowledgeGraph, format: unknown, context: string | undefined, max: number): string | null {
  const total = graph.entities.length;
  const render = (k: number): string => {
    const paged = { entities: graph.entities.slice(0, k), relations: graph.relations };
    return `${pageHeader({ offset: 0, count: k, total, hasMore: true, nextOffset: k })}\n${formatGraph(paged, format, context)}`;
  };
  // 二分搜尋最大 k ∈ [1, total)：render(k) 長度隨 k 單調遞增；k=total 必超過 max，
  // 否則呼叫端不會進入此路徑。
  let lo = 1, hi = total - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (render(mid).length <= max) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return best > 0 ? render(best) : null;
}

// 縱深防禦：讀取型工具的輸出硬性字元上限。超過即截斷並附指引，讓過大的回傳永遠不會
// 撐爆 MCP 客戶端（避免 "Encountered unexpected error during execution"）。截斷可能破壞
// JSON 結構，指引中明示如何縮小結果。
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const notice = `\n\n[truncated: output exceeded ${max} chars (was ${text.length}). Narrow the result: use includeObservations:false, aim_memory_search, or read_all with offset/limit.]`;
  const budget = Math.max(0, max - notice.length);
  return text.slice(0, budget) + notice;
}

// 時間戳與紀錄輸出集中在 diagnostics.ts（儲存層的損壞行紀錄共用同一份格式與 sink）。
// 此處重新匯出，讓既有的匯入點與測試不需改動。
export { macauIsoTimestamp };

// 「實際收到了什麼」的診斷抬頭。缺參數的錯誤只說「缺 X」時，兩種成因共用同一句話而
// 無法分辨：客戶端橋接層送出時就丟了鍵（arguments 裡其餘鍵俱在、獨缺一個），
// 與呼叫端真的沒傳。修法南轅北轍，故必須把鍵清單釘進訊息。
// `args === undefined` 代表 params 根本沒有 arguments 鍵——這與 `arguments: {}` 是兩種
// 不同的客戶端故障形態（整包沒送 vs 送了空物件），共用 (none) 會讓判讀表把兩者混為一談。
// bytes 為 arguments 重新序列化後的 UTF-8 位元組數（非原始線上位元組，量級足以判斷
// payload 是否被截斷）；CJK 每字 3 bytes，位元組數與字元數的落差正是判斷依據。
export function argsDiagnostic(toolName: string, args: Record<string, unknown> | undefined): string {
  const received = args === undefined
    ? '(arguments key absent)'
    : (Object.keys(args).length > 0 ? Object.keys(args).join(',') : '(none)');
  const bytes = args === undefined ? 0 : Buffer.byteLength(JSON.stringify(args), 'utf-8');
  return `[diagnostic] tool=${toolName}; received keys: ${received}; arguments bytes=${bytes}`;
}

// 工具呼叫的拒絕原因。分四類而非一句「缺參數」，是因為它們對應**不同的客戶端故障形態**，
// 需要能分別 grep：整包 arguments 沒送、工具名被損壞、缺資料參數、缺 projectRoot。
type RejectReason =
  | 'unknown-tool'
  | 'arguments-key-absent'
  | 'missing-required-args'
  | 'missing-project-root'
  | 'tool-not-dispatchable';

// 「你是不是想用這個」的最小可信推測。實測診斷日誌（56 筆拒絕）顯示最大單一失敗類別
// 是呼叫端用了**上游官方 memory server 的工具名**（search_nodes / open_nodes / read_graph）
// 或掉了 aim_memory_ 前綴——模型退回訓練先驗，而本 fork 把整個工具面改了名。
// 因此先用「包含關係」對回（涵蓋前綴／後綴變體），再用編輯距離補純拼錯。
// ⚠️ 並列時回 undefined：把呼叫端導向**錯誤**的工具比不給建議更糟，
// 尤其其中不少是破壞性工具（forget / remove_facts）。
const SUGGEST_MAX_EDITS = 2;

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

// 一方包含另一方（任一方向的前綴或後綴）。用於「多／少一段」的變體，
// 這類差異的編輯距離很大（aim_memory_search_nodes 與 aim_memory_search 相差 6），
// 純靠編輯距離抓不到。
function eitherContains(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a) || a.endsWith(b) || b.endsWith(a);
}

export function suggestToolName(name: string, candidates: string[]): string | undefined {
  const contained = candidates.filter(c => eitherContains(name, c));
  if (contained.length === 1) return contained[0];
  if (contained.length > 1) {
    // 以共同前綴最長者為最具體的對應；並列則不猜。
    const ranked = contained
      .map(c => ({ c, len: commonPrefixLength(c, name) }))
      .sort((x, y) => y.len - x.len);
    return ranked[1] && ranked[1].len === ranked[0]!.len ? undefined : ranked[0]!.c;
  }
  const near = candidates.filter(c => boundedLevenshtein(name, c, SUGGEST_MAX_EDITS) <= SUGGEST_MAX_EDITS);
  return near.length === 1 ? near[0] : undefined;
}

// 缺某個必填鍵時，從「送來但 schema 沒有」的鍵裡找最可能是它的拼法。
// 實測最常見的是單複數與同義詞漂移：get 要 names 卻收到 name（10 筆）／entityName（3 筆）、
// forget 要 entityNames 卻收到 names、replace_fact 要 newText 卻收到 newFact／newObservation。
// 大小寫不敏感比對，因為 entityNames 與 names 的關係是後綴而非編輯距離。
// 缺 projectRoot 時的候選路徑指引。候選只進訊息、永不據以寫入，所以措辭必須讓呼叫端
// 自己確認：伺服器結構上無法驗證候選是否就是當次呼叫所屬的 workspace。
export function formatRootCandidates(candidates: string[]): string | undefined {
  if (candidates.length === 0) return undefined;
  const list = candidates.map(c => `"${c}"`).join(', ');
  return candidates.length === 1
    ? `Candidate detected: ${list} — pass it as projectRoot if that is your workspace (this server cannot verify it, since one instance serves every workspace).`
    : `Candidates detected: ${list} — pass the right one as projectRoot (this server will not guess between them).`;
}

// 缺 projectRoot 時的後備解析。回傳 adopted 代表「可以直接用」，candidates 代表「只能建議」。
//
// 兩者的差別是「是不是猜的」：
//   - MCP roots 是客戶端**明確宣告**的工作區。只有一個時它就是答案，直接採用不是猜測。
//     多個時語義不明——挑一個猜錯就是寫進別的專案，所以只列為候選。
//   - cwd 偵測（findProjectRoot）永遠只是候選。workspace-only 的前提就是單一實例服務所有
//     workspace，而行程 cwd 是它啟動時的目錄；實測兩個並存行程一個 cwd=`/`、一個剛好是
//     某 workspace，足證此值不可信。2026-08-23 已發生過帶錯 projectRoot 造成的跨 workspace
//     污染事故，故此路徑對寫入一律 fail-closed。
type RootsState = 'not-declared' | 'declared' | 'request-failed';

async function resolveProjectRootFallback(): Promise<{ adopted?: string; candidates: string[]; rootsState: RootsState }> {
  const caps = server.getClientCapabilities();
  let rootsState: RootsState = caps?.roots === undefined ? 'not-declared' : 'declared';
  if (caps?.roots !== undefined) {
    try {
      // 短超時：客戶端沒回應時不能讓工具呼叫卡住，退回 cwd 候選即可。
      const result = await server.listRoots(undefined, { timeout: ROOTS_TIMEOUT_MS });
      const paths = result.roots
        .filter(r => typeof r.uri === 'string' && r.uri.startsWith('file:'))
        .map(r => fileURLToPath(r.uri as string));
      if (paths.length === 1) return { adopted: paths[0]!, candidates: paths, rootsState };
      if (paths.length > 1) return { candidates: paths, rootsState };
    } catch (error) {
      // 客戶端宣告了能力卻答不出來：這是**例外**而非必然，值得獨立一行紀錄。
      rootsState = 'request-failed';
      const reason = error instanceof Error ? error.message : String(error);
      recordDiagnostic('roots/list failed', `client declared the roots capability but the request failed: ${reason}`);
    }
  }
  // 沒能拿到單一權威 root。rootsState 由呼叫端折進「拒絕」那一行紀錄，
  // 不另開一行——它必然伴隨該拒絕出現，而必然出現的信號不是信號。
  const detected = findProjectRoot();
  return { candidates: detected === null ? [] : [detected], rootsState };
}

const ROOTS_TIMEOUT_MS = 2_000;

// 工具名解析：canonical → 原樣；否則補 aim_memory_ 前綴再試；否則查 alias 表（含補前綴後查）。
// 回 undefined 代表真的無從對應，交由 unknown-tool 拒絕路徑處理（附 did-you-mean）。
// 順序有意義：先認 canonical，確保 alias 表永遠無法遮蔽真正的工具名。
export function resolveToolName(name: string): string | undefined {
  const canonical = new Set(TOOL_DEFINITIONS.map(t => t.name));
  if (canonical.has(name)) return name;
  const prefixed = name.startsWith('aim_memory_') ? name : `aim_memory_${name}`;
  if (canonical.has(prefixed)) return prefixed;
  const aliased = TOOL_NAME_ALIASES[prefixed];
  return aliased !== undefined && canonical.has(aliased) ? aliased : undefined;
}

// 由 schema 推導某參數期望的值形狀，用來守住 alias 改寫。
// 從契約本身推導而非硬編碼一份期望，這樣新增參數時不會漏掉。
type Shape = 'string' | 'string[]' | 'object[]' | 'other';
function shapeOfProp(prop: unknown): Shape {
  const p = prop as { type?: string; items?: { type?: string } } | undefined;
  if (p?.type === 'string') return 'string';
  if (p?.type === 'array') return p.items?.type === 'object' ? 'object[]' : 'string[]';
  return 'other';
}

// 值是否放得進該形狀。`string[]` 額外接受單一字串（呼叫端寫 name: "E" 時包成 ["E"]）。
function fitsShape(value: unknown, shape: Shape): boolean {
  if (shape === 'string') return typeof value === 'string';
  if (shape === 'string[]') {
    return typeof value === 'string' || (Array.isArray(value) && value.every(v => typeof v === 'string'));
  }
  if (shape === 'object[]') {
    return Array.isArray(value) && value.length > 0 && typeof value[0] === 'object' && value[0] !== null;
  }
  return true;
}

// 參數名 alias 改寫。三條守則，缺一都會把「清楚的錯誤」變成「含糊的錯誤」或誤刪資料：
//   1. canonical 已存在時絕不覆蓋（呼叫端同時送了兩者，正確的那個優先）。
//   2. 值的形狀必須放得進 canonical 的宣告形狀，否則保持原樣讓正常的缺參數錯誤發生。
//   3. 改寫後刪掉 alias 鍵，否則 schema 的 XOR 檢查與診斷的「未預期鍵」判讀都會誤判。
export function applyParamAliases(
  toolName: string,
  args: Record<string, unknown>,
  schema: { properties?: Record<string, unknown> },
): { args: Record<string, unknown>; renamed: [string, string][] } {
  const table = PARAM_ALIASES[toolName];
  if (table === undefined) return { args, renamed: [] };

  const props = schema.properties ?? {};
  const renamed: [string, string][] = [];
  let out = args;
  for (const [alias, target] of Object.entries(table)) {
    if (args[alias] === undefined || args[target] !== undefined) continue;
    const shape = shapeOfProp(props[target]);
    if (!fitsShape(args[alias], shape)) continue;
    if (out === args) out = { ...args };
    // 單一字串進 string[]：包成陣列（get 最常見的用法就是取單一實體）。
    out[target] = shape === 'string[]' && typeof out[alias] === 'string' ? [out[alias] as string] : out[alias];
    delete out[alias];
    renamed.push([alias, target]);
  }
  return { args: out, renamed };
}

export function suggestKeyFix(requiredKey: string, unexpectedKeys: string[]): string | undefined {
  const target = requiredKey.toLowerCase();
  const byContainment = unexpectedKeys.filter(k => {
    const lower = k.toLowerCase();
    return lower.length >= 4 && eitherContains(lower, target);
  });
  if (byContainment.length === 1) return byContainment[0];
  if (byContainment.length > 1) return undefined;
  const near = unexpectedKeys.filter(
    k => boundedLevenshtein(k.toLowerCase(), target, SUGGEST_MAX_EDITS) <= SUGGEST_MAX_EDITS,
  );
  return near.length === 1 ? near[0] : undefined;
}

// 工具呼叫的統一拒絕路徑：訊息附診斷抬頭，並在 stderr 留一行帶時間戳與請求 id 的紀錄。
// 為何要寫 stderr——錯誤訊息只回到模型手中，事後在伺服器端不留任何痕跡；要證實
// 「某個時間窗口客戶端連續丟鍵」就必須有可與客戶端日誌對拍的伺服器端紀錄。
// ⚠️ **每一條拒絕路徑都必須走這裡**。曾經只接了缺參數兩條，於是「整包 arguments 丟失」
// 與「工具名損壞」靜默通過，而那兩者恰恰是客戶端故障最極端的形態——結果是
// 「stderr 沒紀錄＝請求沒到伺服器」這條判讀規則本身會給出假結論。
// reqId 是 JSON-RPC 請求 id，客戶端日誌以它索引；缺了就只能靠毫秒時間戳猜對應關係。
// 只在拒絕路徑寫（成功路徑不寫）：必然出現的信號不是信號。
// stdout 為 MCP 協議專用，故診斷一律走 stderr。
// 前綴刻意用 `[aim-memory]`（客戶端掛載此 server 的慣用名稱）而非套件名，
// 讓伺服器端與客戶端兩份日誌能用同一個字串 grep。
function rejectToolCall(
  reason: RejectReason,
  toolName: string,
  args: Record<string, unknown> | undefined,
  requestId: RequestId | undefined,
  message: string,
  extraDiagnostic?: string,
): never {
  const diagnostic = argsDiagnostic(toolName, args);
  const reqId = requestId === undefined ? '(unknown)' : String(requestId);
  const extra = extraDiagnostic === undefined ? '' : `; ${extraDiagnostic}`;
  recordDiagnostic(`tool call rejected (${reason})`, `reqId=${reqId}; ${diagnostic}${extra}`);
  throw new Error(`${message} ${diagnostic}`);
}

// 伺服器實例與公開給 AI 模型的工具
export const server = new Server({
  name: pkg.name,
  version: pkg.version,
}, {
  capabilities: {
    tools: {},
  },
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOL_DEFINITIONS };
});

// 工具呼叫的單一驗證入口，依序檢查四件事並一律走 rejectToolCall（診斷 + stderr）：
// 工具名是否存在、arguments 鍵是否存在、schema 的必填資料參數、workspace-only 的 projectRoot。
// 順序有意義：工具名未知時無從得知它的 required 清單，故必須最先判。
// projectRoot 的訊息主文沿用 storage 的單一真相常量（指引性更強），但診斷抬頭只能在此
// 產生——storage 的 getMemoryFilePath 只收到解析後的 projectRoot，結構上看不到呼叫端
// 實際送來哪些鍵。storage 的同一道檢查保留為最後防線（程式化消費者可繞過 server 層）。
function assertToolCallArgs(
  toolName: string,
  args: Record<string, unknown> | undefined,
  requestId: RequestId | undefined,
  rootCandidates: string[] = [],
  rootsState?: string,
): asserts args is Record<string, unknown> {
  const tool = TOOL_DEFINITIONS.find(t => t.name === toolName);
  // 未知工具在此就明確報錯：否則下面存取 undefined.inputSchema 會丟出隱晦的 TypeError
  // （"Cannot read properties of undefined"），且早於 dispatchTool 的 switch，讓其
  // default 分支的 "Unknown tool" 訊息對「名稱不在定義」的情況永遠走不到。
  if (!tool) {
    // 附最接近的工具名與完整清單。理由是成本不對稱：宿主在工具錯誤時會把整份
    // tools/list 附到回應尾端（實測 40KB），所以在訊息裡放幾百字元的線索讓呼叫端
    // 一次改對，遠比讓它再錯一輪便宜。
    const names = TOOL_DEFINITIONS.map(t => t.name);
    const suggestion = suggestToolName(toolName, names);
    const hint = suggestion ? ` Did you mean "${suggestion}"?` : '';
    rejectToolCall(
      'unknown-tool',
      toolName,
      args,
      requestId,
      `Unknown tool: ${toolName}.${hint} Available tools: ${names.join(', ')}.`,
    );
  }
  if (!args) {
    rejectToolCall(
      'arguments-key-absent',
      toolName,
      undefined,
      requestId,
      `No arguments provided for tool: ${toolName}`,
    );
  }
  const schema = tool.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
  const required = schema.required ?? [];
  const missing = required.filter(key => key !== 'projectRoot' && args[key] === undefined);
  if (missing.length > 0) {
    // 「送來但 schema 沒有」的鍵才是候選拼法；schema 內的合法鍵不參與推測。
    const known = new Set(Object.keys(schema.properties ?? {}));
    const unexpected = Object.keys(args).filter(k => !known.has(k));
    const detail = missing
      .map(key => {
        const guess = suggestKeyFix(key, unexpected);
        return guess ? `${key} (received "${guess}" — did you mean "${key}"?)` : key;
      })
      .join(', ');
    rejectToolCall(
      'missing-required-args',
      toolName,
      args,
      requestId,
      `Missing required argument(s) for ${toolName}: ${detail}`,
    );
  }
  if (workspaceOnly && args.projectRoot === undefined) {
    // 候選路徑接進訊息：實測 10 筆缺 projectRoot 中有 6 筆是 `store | entities`——
    // 呼叫端知道要寫什麼、只是不知道路徑。給它路徑就能一輪改對，而給的同時明說
    // 伺服器無法代為確認，避免把「建議」誤讀成「保證」。
    const hint = formatRootCandidates(rootCandidates);
    const message = hint === undefined ? PROJECT_ROOT_REQUIRED_MESSAGE : `${PROJECT_ROOT_REQUIRED_MESSAGE} ${hint}`;
    // 客戶端的 roots 宣告狀態折進同一行紀錄：沒有它就無法事後分辨「沒宣告／回 0 個／
    // 回多個／宣告了卻答不出來」，而這四者的處理方式完全不同。
    const extra = rootsState === undefined ? undefined : `client roots: ${rootsState}; cwd candidates: ${rootCandidates.length}`;
    rejectToolCall('missing-project-root', toolName, args, requestId, message, extra);
  }
}

// extra.requestId 是本次 tools/call 的 JSON-RPC id。SDK 明確為此用途提供它
// （"useful for tracking or logging purposes"），拒絕路徑的 stderr 紀錄靠它才能與
// 客戶端日誌一一對應，而不是靠毫秒時間戳猜。
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  try {
    return await dispatchTool(request, extra.requestId);
  } catch (error) {
    // 工具層錯誤一律回傳 isError:true 的正常結果，而非拋出讓 SDK 產生協議級
    // JSON-RPC 錯誤（-32603）。有客戶端會把任何協議級錯誤誤判為連線故障，
    // 殺掉健康的 server 行程重連重試（參數不變照樣失敗），對模型呈現為
    // 「Failed to connect」與整段斷連窗口。isError 結果讓錯誤訊息回到模型
    // 手中，模型可據此修正呼叫。錯誤不中斷 server，也不吞掉——訊息完整回傳。
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: message }], isError: true };
  }
});

// 每個工具處理器共用的呼叫脈絡：已通過 assertToolCallArgs 的 arguments，
// 加上「選哪個 store」的三元組（在派發前解構一次，取代各處理器重複 cast）。
interface ToolContext {
  args: Record<string, unknown>;
  context: string | undefined;
  location: 'project' | 'global' | undefined;
  projectRoot: string | undefined;
}

type ToolResult = { content: { type: string; text: string }[] };
type ToolHandler = (ctx: ToolContext) => Promise<ToolResult>;

// 工具名 → 處理器的派發表，取代原本 15 個 case 的 switch。
// 為何改成表：新增工具原本要同時改 tools.ts（schema）與這裡（case），兩者沒有任何
// 編譯期關聯——漏了後者，請求會落到 switch 的 default 丟出「Unknown tool」，
// 而它是**已宣告**的工具，訊息語義錯誤，且該路徑繞過 rejectToolCall 因此不留任何
// 診斷紀錄，違反「每一條拒絕路徑都留紀錄」的契約。表結構讓
// test/tool-contract.test.ts 能以「鍵集合 ≡ TOOL_DEFINITIONS 名稱集合」把漂移釘死。
export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  aim_memory_store: async ({ args, context, location, projectRoot }) => {
    const result = await knowledgeGraphManager.createEntities(args.entities as Entity[], context, location, projectRoot);
    // 向後相容：無 warning 時維持純陣列輸出；有 warning 時才包成 {entities, warnings} 物件。
    const payload = result.warnings.length > 0 ? { entities: result.entities, warnings: result.warnings } : result.entities;
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  },

  aim_memory_link: async ({ args, context, location, projectRoot }) => ({
    content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.createRelations(args.relations as Relation[], context, location, projectRoot, args.allowDangling as boolean | undefined), null, 2) }],
  }),

  aim_memory_add_facts: async ({ args, context, location, projectRoot }) => ({
    content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.addObservations(args.observations as { entityName: string; contents: string[]; upsertKeyed?: boolean }[], context, location, projectRoot), null, 2) }],
  }),

  aim_memory_forget: async ({ args, context, location, projectRoot }) => {
    await knowledgeGraphManager.deleteEntities(args.entityNames as string[], context, location, projectRoot);
    return { content: [{ type: "text", text: "Entities deleted successfully" }] };
  },

  aim_memory_remove_facts: async ({ args, context, location, projectRoot }) => ({
    content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.deleteObservations(args.deletions as DeleteObservationsEntry[], context, location, projectRoot), null, 2) }],
  }),

  aim_memory_unlink: async ({ args, context, location, projectRoot }) => {
    await knowledgeGraphManager.deleteRelations(args.relations as Relation[], context, location, projectRoot);
    return { content: [{ type: "text", text: "Relations deleted successfully" }] };
  },

  aim_memory_read_all: async ({ args, context, location, projectRoot }) => {
      const graph = await knowledgeGraphManager.readGraph(context, location, projectRoot);
      const projected = projectObservations(graph, args.includeObservations);
      // entity 分頁：切片後才格式化，讓大圖可分批讀取；有分頁時前置抬頭告知進度與下一頁 offset。
      const { graph: paged, pageInfo } = paginateGraph(projected, args.offset, args.limit);
      let text = formatGraph(paged, args.format, context);
      if (pageInfo) {
        // 明確分頁後仍超過上限：批次大小由呼叫端掌控，退回硬性截斷作最後防線。
        text = capText(`${pageHeader(pageInfo)}\n${text}`, maxOutputChars);
      } else if (text.length > maxOutputChars) {
        // 未分頁的全圖讀取超過上限：自動降級為第一頁（格式完整、附續讀 offset），
        // 連一個 entity 都放不下才退回硬性截斷。絕不回傳撐爆客戶端的巨量文字。
        text = autoPaginateText(projected, args.format, context, maxOutputChars)
          ?? capText(text, maxOutputChars);
      }
    return { content: [{ type: "text", text }] };
  },

  aim_memory_search: async ({ args, context, location, projectRoot }) => {
    const graph = await knowledgeGraphManager.searchNodes(
      args.query as string,
      context, location, projectRoot,
      { limit: args.limit as number | undefined, depth: args.depth as number | undefined },
    );
    return { content: [{ type: "text", text: capText(formatGraph(graph, args.format, context), maxOutputChars) }] };
  },

  aim_memory_get: async ({ args, context, location, projectRoot }) => {
    const graph = await knowledgeGraphManager.openNodes(args.names as string[], context, location, projectRoot);
    // observation 級過濾（可選）：只留命中條目並附 [obs-filter] 抬頭；未啟動時原樣。
    const { graph: filtered, header } = filterObservations(graph, args.observationPrefix, args.observationSubstring);
    const projected = projectObservations(filtered, args.includeObservations);
    const text = formatGraph(projected, args.format, context);
    return { content: [{ type: "text", text: capText(header ? `${header}\n${text}` : text, maxOutputChars) }] };
  },

  aim_memory_count_observations: async ({ args, context, location, projectRoot }) => {
    const report = await knowledgeGraphManager.countObservations(
      args.names as string[],
      args.observationPrefix as string,
      args.groupByDelimiter as string | undefined,
      context, location, projectRoot,
    );
    return { content: [{ type: "text", text: capText(JSON.stringify(report, null, 2), maxOutputChars) }] };
  },

  aim_memory_list_stores: async ({ projectRoot }) => ({
    content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.listDatabases(projectRoot), null, 2) }],
  }),

  aim_memory_update_entity: async ({ args, context, location, projectRoot }) => {
    const updated = await knowledgeGraphManager.updateEntity(
      args.name as string,
      { newName: args.newName as string | undefined, entityType: args.entityType as string | undefined },
      context, location, projectRoot,
    );
    return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
  },

  aim_memory_replace_fact: async ({ args, context, location, projectRoot }) => {
    const result = await knowledgeGraphManager.replaceFact(
      args.entityName as string,
      {
        prefix: args.matchPrefix as string | undefined,
        substring: args.matchSubstring as string | undefined,
        exact: args.matchExact as string | undefined,
      },
      args.newText as string,
      context, location, projectRoot,
    );
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },

  aim_memory_doctor: async ({ context, location, projectRoot }) => {
    const report = await knowledgeGraphManager.doctor(context, location, projectRoot);
    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  },

  aim_memory_list_entity_types: async ({ context, location, projectRoot }) => {
    const types = await knowledgeGraphManager.listEntityTypes(context, location, projectRoot);
    return { content: [{ type: "text", text: JSON.stringify(types, null, 2) }] };
  },
};

// alias 命中時前置的抬頭。存在的理由：alias 讓呼叫成功，但若什麼都不說，呼叫端就永遠
// 學不到正名，於是每個 session 都靠 alias 撐著（而 alias 是善意的相容層，不是契約）。
// 只在確有改寫時出現——必然出現的信號不是信號。
function aliasNotice(toolAlias: string | undefined, canonicalTool: string, renamed: [string, string][]): string | null {
  const parts: string[] = [];
  if (toolAlias !== undefined) parts.push(`tool "${toolAlias}" -> "${canonicalTool}"`);
  for (const [from, to] of renamed) parts.push(`"${from}" -> "${to}"`);
  if (parts.length === 0) return null;
  return `[alias] accepted and rewritten: ${parts.join('; ')}. Use the canonical names to avoid this notice.`;
}

// 採用了客戶端宣告的 root 時的抬頭。與 alias 同一原則：善意的後備不能是隱形的——
// 呼叫端必須知道記憶實際落在哪個 workspace，否則它無從發現「客戶端宣告的 root
// 其實不是我想要的那個」。
function adoptedRootNotice(adopted: string | undefined): string | null {
  return adopted === undefined
    ? null
    : `[projectRoot] not provided; adopted the single workspace root reported by the client: "${adopted}". Pass projectRoot explicitly to avoid this notice.`;
}

async function dispatchTool(request: CallToolRequest, requestId?: RequestId) {
  const { name: rawName, arguments: rawArgs } = request.params;

  // 名稱正規化先於驗證：上游生態名、掉前綴、單複數與同義詞在此對回 canonical，
  // 讓實測 75% 的拒絕從「失敗一輪再重試」變成「直接成功並學到正名」。
  const resolved = resolveToolName(rawName);
  const name = resolved ?? rawName;
  const toolAlias = resolved !== undefined && resolved !== rawName ? rawName : undefined;

  let args = rawArgs;
  let renamed: [string, string][] = [];
  if (resolved !== undefined && args !== undefined) {
    const tool = TOOL_DEFINITIONS.find(t => t.name === resolved)!;
    const applied = applyParamAliases(resolved, args, tool.inputSchema as { properties?: Record<string, unknown> });
    args = applied.args;
    renamed = applied.renamed;
  }

  // 缺 projectRoot 時的後備解析（只在真的缺時才做，成功路徑零額外往返）。
  // adopted 來自客戶端明確宣告的單一 root——那不是猜測；candidates 只進錯誤訊息。
  let adoptedRoot: string | undefined;
  let rootCandidates: string[] = [];
  let rootsState: string | undefined;
  if (workspaceOnly && args !== undefined && args.projectRoot === undefined) {
    const fallback = await resolveProjectRootFallback();
    rootCandidates = fallback.candidates;
    rootsState = fallback.rootsState;
    if (fallback.adopted !== undefined) {
      adoptedRoot = fallback.adopted;
      args = { ...args, projectRoot: adoptedRoot };
    }
  }

  assertToolCallArgs(name, args, requestId, rootCandidates, rootsState);

  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    // 結構上不該發生：assertToolCallArgs 已保證 name ∈ TOOL_DEFINITIONS，且
    // test/tool-contract.test.ts 守衛「派發表 ≡ 工具定義」。但仍走 rejectToolCall
    // 而非靜默或含糊的 "Unknown tool"——若接線真的漏了，這是**已宣告但未實作**，
    // 訊息必須這樣說，且必須跟其他拒絕路徑一樣留下診斷紀錄。
    rejectToolCall(
      'tool-not-dispatchable',
      name,
      args,
      requestId,
      `Tool ${name} is declared in tools/list but has no handler (server wiring bug).`,
    );
  }

  // 「選哪個 store」的三元組在每個工具都以相同尾隨參數傳給 storage 層；在此解構一次。
  const result = await handler({
    args,
    context: args.context as string | undefined,
    location: args.location as 'project' | 'global' | undefined,
    projectRoot: args.projectRoot as string | undefined,
  });

  const notice = [adoptedRootNotice(adoptedRoot), aliasNotice(toolAlias, name, renamed)]
    .filter((n): n is string => n !== null)
    .join('\n') || null;
  if (notice === null) return result;
  // 前置而非附加：抬頭要在被截斷之前就讓呼叫端看到（讀取型工具的輸出可能很長）。
  const first = result.content[0];
  return first === undefined
    ? { content: [{ type: "text", text: notice }] }
    : { ...result, content: [{ ...first, text: `${notice}\n${first.text}` }, ...result.content.slice(1)] };
}

export async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Knowledge Graph MCP Server running on stdio");
}
