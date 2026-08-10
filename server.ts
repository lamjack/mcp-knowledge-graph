// MCP 伺服器接線：實例化 stdio 伺服器、註冊工具處理器，
// 並匯出 main() 供進入點使用。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { pkg, maxOutputChars } from './config.js';
import {
  knowledgeGraphManager,
  formatGraphPretty,
  formatGraphConcise,
  type KnowledgeGraph,
  type Entity,
  type Relation,
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
  const required = (tool?.inputSchema as { required?: string[] }).required ?? [];
  const missing = required.filter(key => key !== 'projectRoot' && args[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`Missing required argument(s) for ${toolName}: ${missing.join(', ')}`);
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!args) {
    throw new Error(`No arguments provided for tool: ${name}`);
  }

  assertRequiredArgs(name, args as Record<string, unknown>);

  switch (name) {
    case "aim_memory_store": {
      const result = await knowledgeGraphManager.createEntities(args.entities as Entity[], args.context as string, args.location as 'project' | 'global', args.projectRoot as string);
      // 向後相容：無 warning 時維持純陣列輸出；有 warning 時才包成 {entities, warnings} 物件。
      const payload = result.warnings.length > 0 ? { entities: result.entities, warnings: result.warnings } : result.entities;
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }
    case "aim_memory_link":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.createRelations(args.relations as Relation[], args.context as string, args.location as 'project' | 'global', args.projectRoot as string, args.allowDangling as boolean | undefined), null, 2) }] };
    case "aim_memory_add_facts":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.addObservations(args.observations as { entityName: string; contents: string[] }[], args.context as string, args.location as 'project' | 'global', args.projectRoot as string), null, 2) }] };
    case "aim_memory_forget":
      await knowledgeGraphManager.deleteEntities(args.entityNames as string[], args.context as string, args.location as 'project' | 'global', args.projectRoot as string);
      return { content: [{ type: "text", text: "Entities deleted successfully" }] };
    case "aim_memory_remove_facts":
      await knowledgeGraphManager.deleteObservations(args.deletions as { entityName: string; observations: string[] }[], args.context as string, args.location as 'project' | 'global', args.projectRoot as string);
      return { content: [{ type: "text", text: "Observations deleted successfully" }] };
    case "aim_memory_unlink":
      await knowledgeGraphManager.deleteRelations(args.relations as Relation[], args.context as string, args.location as 'project' | 'global', args.projectRoot as string);
      return { content: [{ type: "text", text: "Relations deleted successfully" }] };
    case "aim_memory_read_all": {
      const graph = await knowledgeGraphManager.readGraph(args.context as string, args.location as 'project' | 'global', args.projectRoot as string);
      const projected = projectObservations(graph, args.includeObservations);
      // entity 分頁：切片後才格式化，讓大圖可分批讀取；有分頁時前置抬頭告知進度與下一頁 offset。
      const { graph: paged, pageInfo } = paginateGraph(projected, args.offset, args.limit);
      let text = formatGraph(paged, args.format, args.context as string);
      if (pageInfo) text = `${pageHeader(pageInfo)}\n${text}`;
      // 縱深防禦上限：即使未分頁或分頁後仍過大，也絕不回傳撐爆客戶端的巨量文字。
      return { content: [{ type: "text", text: capText(text, maxOutputChars) }] };
    }
    case "aim_memory_search": {
      const graph = await knowledgeGraphManager.searchNodes(
        args.query as string,
        args.context as string,
        args.location as 'project' | 'global',
        args.projectRoot as string,
        { limit: args.limit as number | undefined, depth: args.depth as number | undefined },
      );
      return { content: [{ type: "text", text: capText(formatGraph(graph, args.format, args.context as string), maxOutputChars) }] };
    }
    case "aim_memory_get": {
      const graph = await knowledgeGraphManager.openNodes(args.names as string[], args.context as string, args.location as 'project' | 'global', args.projectRoot as string);
      const projected = projectObservations(graph, args.includeObservations);
      return { content: [{ type: "text", text: capText(formatGraph(projected, args.format, args.context as string), maxOutputChars) }] };
    }
    case "aim_memory_list_stores":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.listDatabases(args.projectRoot as string), null, 2) }] };
    case "aim_memory_update_entity": {
      const updated = await knowledgeGraphManager.updateEntity(
        args.name as string,
        { newName: args.newName as string | undefined, entityType: args.entityType as string | undefined },
        args.context as string,
        args.location as 'project' | 'global',
        args.projectRoot as string,
      );
      return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
    }
    case "aim_memory_replace_fact": {
      const result = await knowledgeGraphManager.replaceFact(
        args.entityName as string,
        { prefix: args.matchPrefix as string | undefined, substring: args.matchSubstring as string | undefined },
        args.newText as string,
        args.context as string,
        args.location as 'project' | 'global',
        args.projectRoot as string,
      );
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    case "aim_memory_doctor": {
      const report = await knowledgeGraphManager.doctor(args.context as string, args.location as 'project' | 'global', args.projectRoot as string);
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }
    case "aim_memory_list_entity_types": {
      const types = await knowledgeGraphManager.listEntityTypes(args.context as string, args.location as 'project' | 'global', args.projectRoot as string);
      return { content: [{ type: "text", text: JSON.stringify(types, null, 2) }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

export async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Knowledge Graph MCP Server running on stdio");
}
