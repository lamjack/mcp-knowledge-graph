// MCP 伺服器接線：實例化 stdio 伺服器、註冊工具處理器，
// 並匯出 main() 供進入點使用。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { pkg } from './config.js';
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
      return { content: [{ type: "text", text: formatGraph(projected, args.format, args.context as string) }] };
    }
    case "aim_memory_search": {
      const graph = await knowledgeGraphManager.searchNodes(
        args.query as string,
        args.context as string,
        args.location as 'project' | 'global',
        args.projectRoot as string,
        { limit: args.limit as number | undefined, depth: args.depth as number | undefined },
      );
      return { content: [{ type: "text", text: formatGraph(graph, args.format, args.context as string) }] };
    }
    case "aim_memory_get": {
      const graph = await knowledgeGraphManager.openNodes(args.names as string[], args.context as string, args.location as 'project' | 'global', args.projectRoot as string);
      const projected = projectObservations(graph, args.includeObservations);
      return { content: [{ type: "text", text: formatGraph(projected, args.format, args.context as string) }] };
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
