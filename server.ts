// MCP 伺服器接線：實例化 stdio 伺服器、註冊工具處理器，
// 並匯出 main() 供進入點使用。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js";

import { pkg, maxOutputChars } from './config.js';
import {
  knowledgeGraphManager,
  formatGraphPretty,
  formatGraphConcise,
  type KnowledgeGraph,
  type Entity,
  type Relation,
  type DeleteObservationsEntry,
} from './storage.js';
import { TOOL_DEFINITIONS } from './tools.js';

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

// 將 client 傳入的數值正規化為非負整數；非有限數（未提供/NaN/Infinity）回傳 undefined。
// 與 searchNodes 的 limit/depth 正規化採相同語義，確保跨工具一致。
function normNonNeg(raw: unknown): number | undefined {
  return (typeof raw === 'number' && Number.isFinite(raw)) ? Math.max(0, Math.floor(raw)) : undefined;
}

// read_all 的 entity 分頁：以 offset/limit 切片 entities，relations 原樣保留。
// 僅在確有分頁意圖（提供 limit，或 offset > 0）時啟用；否則回傳原圖且 pageInfo 為 null，
// 維持不帶分頁參數時的既有行為（含 JSON 輸出逐位元組相容）。
export function paginateGraph(graph: KnowledgeGraph, rawOffset: unknown, rawLimit: unknown): { graph: KnowledgeGraph; pageInfo: PageInfo | null } {
  const offset = normNonNeg(rawOffset) ?? 0;
  const limit = normNonNeg(rawLimit); // undefined = 不限筆數
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

// 依工具 schema 的 required 檢查必要參數是否存在，提供比下游 TypeError
// 更清楚的錯誤訊息。projectRoot 交由 storage 層處理（其訊息更具指引性），
// 這裡略過以免蓋掉 workspace-only 的專屬提示。
function assertRequiredArgs(toolName: string, args: Record<string, unknown>): void {
  const tool = TOOL_DEFINITIONS.find(t => t.name === toolName);
  // 未知工具在此就明確報錯：否則下面存取 undefined.inputSchema 會丟出隱晦的 TypeError
  // （"Cannot read properties of undefined"），且早於 dispatchTool 的 switch，讓其
  // default 分支的 "Unknown tool" 訊息對「名稱不在定義」的情況永遠走不到。
  if (!tool) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  const required = (tool.inputSchema as { required?: string[] }).required ?? [];
  const missing = required.filter(key => key !== 'projectRoot' && args[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`Missing required argument(s) for ${toolName}: ${missing.join(', ')}`);
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    return await dispatchTool(request);
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

async function dispatchTool(request: CallToolRequest) {
  const { name, arguments: args } = request.params;

  if (!args) {
    throw new Error(`No arguments provided for tool: ${name}`);
  }

  assertRequiredArgs(name, args as Record<string, unknown>);

  // 「選哪個 store」的三元組在每個工具都以相同尾隨參數傳給 storage 層；
  // 在此解構一次，取代各 case 重複的 `args.context as ... , args.location as ... , args.projectRoot as ...` cast。
  const context = args.context as string | undefined;
  const location = args.location as 'project' | 'global' | undefined;
  const projectRoot = args.projectRoot as string | undefined;

  switch (name) {
    case "aim_memory_store": {
      const result = await knowledgeGraphManager.createEntities(args.entities as Entity[], context, location, projectRoot);
      // 向後相容：無 warning 時維持純陣列輸出；有 warning 時才包成 {entities, warnings} 物件。
      const payload = result.warnings.length > 0 ? { entities: result.entities, warnings: result.warnings } : result.entities;
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }
    case "aim_memory_link":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.createRelations(args.relations as Relation[], context, location, projectRoot, args.allowDangling as boolean | undefined), null, 2) }] };
    case "aim_memory_add_facts":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.addObservations(args.observations as { entityName: string; contents: string[]; upsertKeyed?: boolean }[], context, location, projectRoot), null, 2) }] };
    case "aim_memory_forget":
      await knowledgeGraphManager.deleteEntities(args.entityNames as string[], context, location, projectRoot);
      return { content: [{ type: "text", text: "Entities deleted successfully" }] };
    case "aim_memory_remove_facts":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.deleteObservations(args.deletions as DeleteObservationsEntry[], context, location, projectRoot), null, 2) }] };
    case "aim_memory_unlink":
      await knowledgeGraphManager.deleteRelations(args.relations as Relation[], context, location, projectRoot);
      return { content: [{ type: "text", text: "Relations deleted successfully" }] };
    case "aim_memory_read_all": {
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
    }
    case "aim_memory_search": {
      const graph = await knowledgeGraphManager.searchNodes(
        args.query as string,
        context, location, projectRoot,
        { limit: args.limit as number | undefined, depth: args.depth as number | undefined },
      );
      return { content: [{ type: "text", text: capText(formatGraph(graph, args.format, context), maxOutputChars) }] };
    }
    case "aim_memory_get": {
      const graph = await knowledgeGraphManager.openNodes(args.names as string[], context, location, projectRoot);
      // observation 級過濾（可選）：只留命中條目並附 [obs-filter] 抬頭；未啟動時原樣。
      const { graph: filtered, header } = filterObservations(graph, args.observationPrefix, args.observationSubstring);
      const projected = projectObservations(filtered, args.includeObservations);
      const text = formatGraph(projected, args.format, context);
      return { content: [{ type: "text", text: capText(header ? `${header}\n${text}` : text, maxOutputChars) }] };
    }
    case "aim_memory_count_observations": {
      const report = await knowledgeGraphManager.countObservations(
        args.names as string[],
        args.observationPrefix as string,
        args.groupByDelimiter as string | undefined,
        context, location, projectRoot,
      );
      return { content: [{ type: "text", text: capText(JSON.stringify(report, null, 2), maxOutputChars) }] };
    }
    case "aim_memory_list_stores":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.listDatabases(projectRoot), null, 2) }] };
    case "aim_memory_update_entity": {
      const updated = await knowledgeGraphManager.updateEntity(
        args.name as string,
        { newName: args.newName as string | undefined, entityType: args.entityType as string | undefined },
        context, location, projectRoot,
      );
      return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
    }
    case "aim_memory_replace_fact": {
      const result = await knowledgeGraphManager.replaceFact(
        args.entityName as string,
        { prefix: args.matchPrefix as string | undefined, substring: args.matchSubstring as string | undefined },
        args.newText as string,
        context, location, projectRoot,
      );
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    case "aim_memory_doctor": {
      const report = await knowledgeGraphManager.doctor(context, location, projectRoot);
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }
    case "aim_memory_list_entity_types": {
      const types = await knowledgeGraphManager.listEntityTypes(context, location, projectRoot);
      return { content: [{ type: "text", text: JSON.stringify(types, null, 2) }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Knowledge Graph MCP Server running on stdio");
}
