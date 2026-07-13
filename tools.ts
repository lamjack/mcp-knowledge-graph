// MCP 工具 schema 定義。共享屬性片段只宣告一次（DRY），跨工具重複使用。

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { workspaceOnly } from "./config.js";

// 共享的 input-schema 屬性片段（單一真實來源）。
const projectRootProp = {
  type: "string",
  description: "Optional absolute path to the current workspace/project root. When set, memory is stored in <projectRoot>/.aim/ (created if needed), overriding auto-detection. Use this in multi-workspace IDEs (e.g. Windsurf) where the server's working directory is not the project root. Must be an absolute path. REQUIRED when the server runs with --workspace-only."
};

const locationProp = {
  type: "string",
  enum: ["project", "global"],
  description: "Optional storage location override. 'project' forces project-local .aim directory, 'global' forces global directory. If not specified, uses automatic detection."
};

const formatProp = {
  type: "string",
  enum: ["json", "pretty"],
  description: "Output format. 'json' (default) for structured data, 'pretty' for human-readable text."
};

export const TOOL_DEFINITIONS: Tool[] = [
  {
    name: "aim_memory_store",
    description: `Store new memories. Use this to remember people, projects, concepts, or any information worth persisting.

AIM (AI Memory) provides persistent memory for AI assistants. The 'aim_memory_' prefix groups all memory tools together.

WHAT'S STORED: Memories have a name, type (person/project/concept/etc.), and observations (facts about them).

DATABASES: Use the 'context' parameter to organize memories into separate graphs:
- Leave blank: Uses the master database (default for general information)
- Any name: Creates/uses a named database ('work', 'personal', 'health', 'research', etc.)
- New databases are created automatically - no setup required
- IMPORTANT: Use consistent, simple names - prefer 'work' over 'work-stuff'

STORAGE LOCATIONS: Files are stored as JSONL (e.g., memory.jsonl, memory-work.jsonl):
- Project-local: .aim directory in project root (auto-detected if exists)
- Global: User's configured --memory-path directory
- Use 'location' parameter to override: 'project' or 'global'

RETURNS: Array of created entities.

EXAMPLES:
- Master database (default): aim_memory_store({entities: [{name: "John", entityType: "person", observations: ["Met at conference"]}]})
- Work database: aim_memory_store({context: "work", entities: [{name: "Q4_Project", entityType: "project", observations: ["Due December 2024"]}]})
- Master database in global location: aim_memory_store({location: "global", entities: [{name: "John", entityType: "person", observations: ["Met at conference"]}]})
- Work database in project location: aim_memory_store({context: "work", location: "project", entities: [{name: "Q4_Project", entityType: "project", observations: ["Due December 2024"]}]})`,
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: projectRootProp,
        context: {
          type: "string",
          description: "Optional memory context. Defaults to master database if not specified. Use any descriptive name ('work', 'personal', 'health', 'basket-weaving', etc.) - new contexts created automatically."
        },
        location: locationProp,
        entities: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "The name of the entity" },
              entityType: { type: "string", description: "The type of the entity" },
              observations: {
                type: "array",
                items: { type: "string" },
                description: "An array of observation contents associated with the entity"
              },
            },
            required: ["name", "entityType", "observations"],
          },
        },
      },
      required: ["entities"],
    },
  },
  {
    name: "aim_memory_link",
    description: `Link two memories together with a relationship. Use this to connect related information.

RELATION STRUCTURE: Each link has 'from' (subject), 'relationType' (verb), and 'to' (object).
- Use active voice verbs: "manages", "works_at", "knows", "attended", "created"
- Read as: "from relationType to" (e.g., "Alice manages Q4_Project")
- Avoid passive: use "manages" not "is_managed_by"

IMPORTANT: Both 'from' and 'to' entities must already exist in the same database.

RETURNS: Array of created relations (duplicates are ignored).

DATABASE: Relations are created in the specified 'context' database, or master database if not specified.

EXAMPLES:
- aim_memory_link({relations: [{from: "John", to: "TechConf2024", relationType: "attended"}]})
- aim_memory_link({context: "work", relations: [{from: "Alice", to: "Q4_Project", relationType: "manages"}]})
- Multiple: aim_memory_link({relations: [{from: "John", to: "Alice", relationType: "knows"}, {from: "John", to: "Acme_Corp", relationType: "works_at"}]})`,
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: projectRootProp,
        context: {
          type: "string",
          description: "Optional memory context. Relations will be created in the specified context's knowledge graph."
        },
        location: locationProp,
        relations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              from: { type: "string", description: "The name of the entity where the relation starts" },
              to: { type: "string", description: "The name of the entity where the relation ends" },
              relationType: { type: "string", description: "The type of the relation" },
            },
            required: ["from", "to", "relationType"],
          },
        },
      },
      required: ["relations"],
    },
  },
  {
    name: "aim_memory_add_facts",
    description: `Add new facts to an existing memory. Use this to append information to something already stored.

IMPORTANT: Memory must already exist - use aim_memory_store first. Throws error if not found.

RETURNS: Array of {entityName, addedObservations} showing what was added (duplicates are ignored).

DATABASE: Adds to entities in the specified 'context' database, or master database if not specified.

EXAMPLES:
- aim_memory_add_facts({observations: [{entityName: "John", contents: ["Lives in Seattle", "Works in tech"]}]})
- aim_memory_add_facts({context: "work", observations: [{entityName: "Q4_Project", contents: ["Behind schedule", "Need more resources"]}]})`,
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: projectRootProp,
        context: {
          type: "string",
          description: "Optional memory context. Observations will be added to entities in the specified context's knowledge graph."
        },
        location: locationProp,
        observations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              entityName: { type: "string", description: "The name of the entity to add the observations to" },
              contents: {
                type: "array",
                items: { type: "string" },
                description: "An array of observation contents to add"
              },
            },
            required: ["entityName", "contents"],
          },
        },
      },
      required: ["observations"],
    },
  },
  {
    name: "aim_memory_forget",
    description: `Forget memories. Removes memories and their associated links.

DATABASE SELECTION: Entities are deleted from the specified database's knowledge graph.

LOCATION OVERRIDE: Use the 'location' parameter to force deletion from 'project' (.aim directory) or 'global' (configured directory). Leave blank for auto-detection.

EXAMPLES:
- Master database (default): aim_memory_forget({entityNames: ["OldProject"]})
- Work database: aim_memory_forget({context: "work", entityNames: ["CompletedTask", "CancelledMeeting"]})
- Master database in global location: aim_memory_forget({location: "global", entityNames: ["OldProject"]})
- Personal database in project location: aim_memory_forget({context: "personal", location: "project", entityNames: ["ExpiredReminder"]})`,
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: projectRootProp,
        context: {
          type: "string",
          description: "Optional memory context. Entities will be deleted from the specified context's knowledge graph."
        },
        location: locationProp,
        entityNames: {
          type: "array",
          items: { type: "string" },
          description: "An array of entity names to delete"
        },
      },
      required: ["entityNames"],
    },
  },
  {
    name: "aim_memory_remove_facts",
    description: `Remove specific facts from a memory. Keeps the memory but removes selected observations.

DATABASE SELECTION: Observations are deleted from entities within the specified database's knowledge graph.

LOCATION OVERRIDE: Use the 'location' parameter to force deletion from 'project' (.aim directory) or 'global' (configured directory). Leave blank for auto-detection.

EXAMPLES:
- Master database (default): aim_memory_remove_facts({deletions: [{entityName: "John", observations: ["Outdated info"]}]})
- Work database: aim_memory_remove_facts({context: "work", deletions: [{entityName: "Project", observations: ["Old deadline"]}]})
- Master database in global location: aim_memory_remove_facts({location: "global", deletions: [{entityName: "John", observations: ["Outdated info"]}]})
- Health database in project location: aim_memory_remove_facts({context: "health", location: "project", deletions: [{entityName: "Exercise", observations: ["Injured knee"]}]})`,
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: projectRootProp,
        context: {
          type: "string",
          description: "Optional memory context. Observations will be deleted from entities in the specified context's knowledge graph."
        },
        location: locationProp,
        deletions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              entityName: { type: "string", description: "The name of the entity containing the observations" },
              observations: {
                type: "array",
                items: { type: "string" },
                description: "An array of observations to delete"
              },
            },
            required: ["entityName", "observations"],
          },
        },
      },
      required: ["deletions"],
    },
  },
  {
    name: "aim_memory_unlink",
    description: `Remove links between memories. Keeps the memories but removes their connections.

DATABASE SELECTION: Relations are deleted from the specified database's knowledge graph.

LOCATION OVERRIDE: Use the 'location' parameter to force deletion from 'project' (.aim directory) or 'global' (configured directory). Leave blank for auto-detection.

EXAMPLES:
- Master database (default): aim_memory_unlink({relations: [{from: "John", to: "OldCompany", relationType: "worked_at"}]})
- Work database: aim_memory_unlink({context: "work", relations: [{from: "Alice", to: "CancelledProject", relationType: "manages"}]})
- Master database in global location: aim_memory_unlink({location: "global", relations: [{from: "John", to: "OldCompany", relationType: "worked_at"}]})
- Personal database in project location: aim_memory_unlink({context: "personal", location: "project", relations: [{from: "Me", to: "OldHobby", relationType: "enjoys"}]})`,
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: projectRootProp,
        context: {
          type: "string",
          description: "Optional memory context. Relations will be deleted from the specified context's knowledge graph."
        },
        location: locationProp,
        relations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              from: { type: "string", description: "The name of the entity where the relation starts" },
              to: { type: "string", description: "The name of the entity where the relation ends" },
              relationType: { type: "string", description: "The type of the relation" },
            },
            required: ["from", "to", "relationType"],
          },
          description: "An array of relations to delete"
        },
      },
      required: ["relations"],
    },
  },
  {
    name: "aim_memory_read_all",
    description: `Read all memories in a database. Returns every stored memory and their links.

FORMAT OPTIONS:
- "json" (default): Structured JSON for programmatic use
- "pretty": Human-readable text format

DATABASE: Reads from the specified 'context' database, or master database if not specified.

EXAMPLES:
- aim_memory_read_all({}) - JSON format
- aim_memory_read_all({format: "pretty"}) - Human-readable
- aim_memory_read_all({context: "work", format: "pretty"}) - Work database, pretty`,
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: projectRootProp,
        context: {
          type: "string",
          description: "Optional memory context. Reads from the specified context's knowledge graph or master database if not specified."
        },
        location: locationProp,
        format: formatProp,
      },
    },
  },
  {
    name: "aim_memory_search",
    description: `Search memories by keyword. Use this when you don't know the exact name of what you're looking for.

WHAT IT SEARCHES: Matches query (case-insensitive) against:
- Memory names (e.g., "John" matches "John_Smith")
- Memory types (e.g., "person" matches all person memories)
- Facts/observations (e.g., "Seattle" matches memories mentioning Seattle)

VS aim_memory_get: Use aim_memory_search for fuzzy matching. Use aim_memory_get when you know exact names.

FORMAT OPTIONS:
- "json" (default): Structured JSON for programmatic use
- "pretty": Human-readable text format

EXAMPLES:
- aim_memory_search({query: "John"}) - JSON format
- aim_memory_search({query: "project", format: "pretty"}) - Human-readable
- aim_memory_search({context: "work", query: "Shane", format: "pretty"})`,
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: projectRootProp,
        context: {
          type: "string",
          description: "Optional database name. Searches within this database or master database if not specified."
        },
        location: locationProp,
        query: { type: "string", description: "Search text to match against entity names, entity types, and observation content (case-insensitive)" },
        format: formatProp,
      },
      required: ["query"],
    },
  },
  {
    name: "aim_memory_get",
    description: `Retrieve specific memories by exact name. Use this when you know exactly what you're looking for.

VS aim_memory_search: Use aim_memory_get for exact name lookup. Use aim_memory_search for fuzzy matching or when you don't know exact names.

RETURNS: Requested entities and relations between them. Non-existent names are silently ignored.

FORMAT OPTIONS:
- "json" (default): Structured JSON for programmatic use
- "pretty": Human-readable text format

EXAMPLES:
- aim_memory_get({names: ["John", "TechConf2024"]}) - JSON format
- aim_memory_get({names: ["Shane"], format: "pretty"}) - Human-readable
- aim_memory_get({context: "work", names: ["Q4_Project"], format: "pretty"})`,
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: projectRootProp,
        context: {
          type: "string",
          description: "Optional memory context. Retrieves entities from the specified context's knowledge graph or master database if not specified."
        },
        location: locationProp,
        names: {
          type: "array",
          items: { type: "string" },
          description: "An array of entity names to retrieve",
        },
        format: formatProp,
      },
      required: ["names"],
    },
  },
  {
    name: "aim_memory_list_stores",
    description: `List all available memory databases and show current storage location.

DATABASE TYPES:
- "default": The master database (memory.jsonl) - used when no context is specified
- Named databases: Created via context parameter (e.g., "work" -> memory-work.jsonl)

RETURNS: {project_databases: [...], global_databases: [...], current_location: "..."}
- project_databases: Databases in .aim directory (if project detected)
- global_databases: Databases in global --memory-path directory
- current_location: Where operations will default to

Use this to discover what databases exist before querying them.

EXAMPLES:
- aim_memory_list_stores() - Shows all available databases and current storage location`,
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: {
          type: "string",
          description: "Optional absolute path to the current workspace/project root. When set, lists databases in <projectRoot>/.aim/ instead of the auto-detected project. Use this in multi-workspace IDEs (e.g. Windsurf). Must be an absolute path."
        }
      },
    },
  },
];

// Workspace-only 嚴格模式：對外公告的 schema 需與執行時的 fail-closed 行為一致，
// 否則模型會照著描述送出被拒絕的 global 呼叫。因此在此模式下：
//   1. 將 projectRoot 標記為每個工具必填（提示層；實際強制在 storage.ts）。
//   2. 移除 location 屬性 —— global 被停用、project 在有 projectRoot 時多餘。
//   3. 於描述最前面加註，讓模型忽略下方任何 global/location 範例。
if (workspaceOnly) {
  const note =
    "[workspace-only mode] Always pass projectRoot set to the current workspace's absolute root path. " +
    "Global storage and the 'location' parameter are disabled in this mode; ignore any 'global'/'location' examples below.\n\n";
  for (const tool of TOOL_DEFINITIONS) {
    const schema = tool.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
    schema.required = Array.from(new Set([...(schema.required ?? []), "projectRoot"]));
    if (schema.properties) {
      delete schema.properties.location;
    }
    tool.description = note + (tool.description ?? "");
  }
}
