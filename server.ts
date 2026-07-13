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
  type Entity,
  type Relation,
} from './storage.js';
import { TOOL_DEFINITIONS } from './tools.js';

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

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!args) {
    throw new Error(`No arguments provided for tool: ${name}`);
  }

  switch (name) {
    case "aim_memory_store":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.createEntities(args.entities as Entity[], args.context as string, args.location as 'project' | 'global', args.projectRoot as string), null, 2) }] };
    case "aim_memory_link":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.createRelations(args.relations as Relation[], args.context as string, args.location as 'project' | 'global', args.projectRoot as string), null, 2) }] };
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
      const output = args.format === 'pretty'
        ? formatGraphPretty(graph, args.context as string)
        : JSON.stringify(graph, null, 2);
      return { content: [{ type: "text", text: output }] };
    }
    case "aim_memory_search": {
      const graph = await knowledgeGraphManager.searchNodes(args.query as string, args.context as string, args.location as 'project' | 'global', args.projectRoot as string);
      const output = args.format === 'pretty'
        ? formatGraphPretty(graph, args.context as string)
        : JSON.stringify(graph, null, 2);
      return { content: [{ type: "text", text: output }] };
    }
    case "aim_memory_get": {
      const graph = await knowledgeGraphManager.openNodes(args.names as string[], args.context as string, args.location as 'project' | 'global', args.projectRoot as string);
      const output = args.format === 'pretty'
        ? formatGraphPretty(graph, args.context as string)
        : JSON.stringify(graph, null, 2);
      return { content: [{ type: "text", text: output }] };
    }
    case "aim_memory_list_stores":
      return { content: [{ type: "text", text: JSON.stringify(await knowledgeGraphManager.listDatabases(args.projectRoot as string), null, 2) }] };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

export async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Knowledge Graph MCP Server running on stdio");
}
