// MCP 工具 schema 定義。共享屬性片段只宣告一次（DRY），跨工具重複使用。

import type { Tool, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { workspaceOnly } from "./config.js";

// Tool annotations（spec 2025-06-18）：讓客戶端不必解析描述文字就能分辨唯讀與破壞性工具，
// 並給刪除類操作一個確認 UX 的掛點。四個 hint 全部顯式給出而非依賴預設值（預設
// readOnlyHint:false / destructiveHint:true 對本 server 的多數工具是錯的）。
// openWorldHint 一律 false：所有工具的作用域都是本地 JSONL 圖譜，屬封閉世界。
// 分類對應執行期行為（7 唯讀 / 3 純附加 / 5 破壞性），由 tool-contract 測試逐工具鎖定。
const readOnlyAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
// store 跳過既有名、link 去重、add_facts 去重——同參數重放對環境無額外效果。
// add_facts 的 upsertKeyed 雖會刪同鍵行，但那是呼叫端逐 entry 顯式 opt-in 的槽位歸一，
// 工具本性是附加，故 destructiveHint 仍為 false。
const additiveAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const destructiveAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};
// update_entity 的 rename 不可重放：第二次呼叫時舊名已不存在，會報錯而非無效果。
const destructiveNonIdempotentAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

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
  enum: ["json", "pretty", "concise"],
  description: "Output format. 'json' (default) for structured data, 'pretty' for human-readable text, 'concise' for a token-efficient one-line-per-entity form (best for feeding results back into an LLM context)."
};

const includeObservationsProp = {
  type: "boolean",
  description: "Optional. Defaults to true (observations included). When false, returns only each entity's name + entityType (observations omitted) plus the full relation skeleton - useful for auditing/indexing large graphs without emitting hundreds of KB that would be truncated."
};

export const TOOL_DEFINITIONS: Tool[] = [
  {
    name: "aim_memory_store",
    annotations: additiveAnnotations,
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

RETURNS: Array of created entities, or {entities, warnings} when there is anything to warn about.

⚠️ NEVER OVERWRITES: an entity whose name already exists is skipped and its observations are discarded. That is not an error, but it is reported as a warning naming the entity and how many observations were dropped, so a "write" that never landed cannot pass for success. To change an existing entity use aim_memory_add_facts (append), add_facts with upsertKeyed (replace one keyed state slot), or aim_memory_replace_fact.

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
    annotations: additiveAnnotations,
    description: `Link two memories together with a relationship. Use this to connect related information.

RELATION STRUCTURE: Each link has 'from' (subject), 'relationType' (verb), and 'to' (object).
- Use active voice verbs: "manages", "works_at", "knows", "attended", "created"
- Read as: "from relationType to" (e.g., "Alice manages Q4_Project")
- Avoid passive: use "manages" not "is_managed_by"

IMPORTANT: Both 'from' and 'to' entities must already exist in the same database. By default, linking to a non-existent endpoint is REJECTED (prevents dangling/ghost edges); the error lists the missing endpoints. Pass allowDangling:true only if you deliberately want an edge to an entity you will create later.

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
        allowDangling: {
          type: "boolean",
          description: "Optional escape hatch (default false). By default, linking to a non-existent 'from'/'to' entity is rejected to prevent dangling edges. Set true to allow creating relations whose endpoints do not yet exist (legacy permissive behavior)."
        },
      },
      required: ["relations"],
    },
  },
  {
    name: "aim_memory_add_facts",
    annotations: additiveAnnotations,
    description: `Add new facts to an existing memory. Use this to append information to something already stored.

IMPORTANT: Memory must already exist - use aim_memory_store first. Throws error if not found.

RETURNS: Array of {entityName, addedObservations} showing what was added (duplicates are ignored). Entries using upsertKeyed also return replacedObservations.

APPEND VS UPSERT: By default this appends, so writing a newer version of a fact leaves the old one in place and both are recalled forever. Set upsertKeyed:true on an entry to make its 'key: value' contents overwrite the same key on that entity instead - use it for single-valued state slots (deploy procedure, current version, chosen approach) so a slot always holds exactly one current line.

WRITE STATE, NOT A JOURNAL: the date goes inside the value, never in the key. "deploy (2026-08-12): ..." mints a new key on every write, so nothing can supersede it and no tool can find the pile-up. Write "deploy procedure: ...; last_verified: 2026-08-12" with upsertKeyed instead. A momentary observation ("checked today, all healthy") has no value once the day passes - anyone who needs it will look at the live system - so it belongs in the session log, which is pruned, not on a domain entity, which is not. Genuinely multi-valued keys (several "service: ..." lines) stay append-only: upsertKeyed there would delete the siblings.

FRESHNESS STAMP: exactly "; last_verified: <ISO date>" at the end of the value. One spelling only - a parenthetical "(verified ...)" cannot be matched later, so it is the same as no stamp.

SLOT NAMES: reuse these key heads rather than inventing a synonym, so the same fact lands in the same slot and is overwritten instead of duplicated - "deploy procedure:", "deployed images:", "host:", "port:", "namespace:", "registry:", "current version:", "chosen approach:", "owner:", "known pitfall:" (that last one is multi-valued, append-only, never dated).

DO NOT COPY WHAT THE REPO DEFINES: commands, chart or image versions, paths and config layout live in the codebase (AGENTS.md, Makefile, chart and values files) and change without anybody updating this graph, so a copy here goes stale silently and is recalled as current. Store a pointer instead - "deploy SSoT: <file> <section>; last_verified: <date>". A recorded state of a remote system (deployed, running, healthy) is a lead to confirm, never a fact.

DATABASE: Adds to entities in the specified 'context' database, or master database if not specified.

EXAMPLES:
- aim_memory_add_facts({observations: [{entityName: "John", contents: ["Lives in Seattle", "Works in tech"]}]})
- Upsert a state slot: aim_memory_add_facts({observations: [{entityName: "Staging", contents: ["deploy procedure: pull then recreate; last_verified: 2026-08-20"], upsertKeyed: true}]})
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
              upsertKeyed: {
                type: "boolean",
                description: "Optional (default false = append-only). When true, each content shaped as 'key: value' first deletes existing observations on this entity with the same key head (':' and '：' both count), so a state slot keeps exactly one current line. Contents without a key head are appended as usual. Opt-in on purpose: enabling it for a legitimately multi-valued key would delete the sibling entries."
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
    annotations: destructiveAnnotations,
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
    annotations: destructiveAnnotations,
    description: `Remove specific facts from a memory. Keeps the memory but removes selected observations, either by exact text or by prefix.

MATCH MODES (per deletion entry, provide exactly one, non-empty):
- observations: ["full exact text", ...] - deletes observations identical to any given string
- observationPrefix: "session 2026-08-01T10:00:00+08:00｜" - deletes EVERY observation starting with this prefix. The natural way to prune a whole prefixed block without transcribing long/CJK text (exact matching of long strings is brittle and silently matched nothing in the past).

RETURNS: Per-entity report array [{entityName, entityExists, requested, removed, unmatched}] - you can ALWAYS tell how much was actually deleted:
- requested: deletion items given (exact mode: distinct string count; prefix mode: 1)
- removed: observations actually deleted
- unmatched: requested items that matched nothing (exact mode: the unmatched strings; prefix mode echoes the prefix when 0 matched)
- entityExists:false: no such entity - nothing deleted for that name, other entries still processed
- A call that removes nothing does not modify the file at all.

EXAMPLES:
- Exact: aim_memory_remove_facts({deletions: [{entityName: "John", observations: ["Outdated info"]}]})
- Prefix (prune a whole block): aim_memory_remove_facts({deletions: [{entityName: "Log", observationPrefix: "session 2026-08-01T10:00:00+08:00｜"}]})
- Verify afterwards with aim_memory_count_observations or aim_memory_get({observationPrefix: ...})`,
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
                description: "Observations to delete by exact text. Provide exactly one of observations or observationPrefix per entry."
              },
              observationPrefix: {
                type: "string",
                description: "Delete every observation starting with this prefix. Provide exactly one of observations or observationPrefix per entry."
              },
            },
            required: ["entityName"],
            // 「恰擇一」寫進 schema 而非只在執行期強制：呼叫端讀不到約束就只能靠失敗
            // 學習，而實測診斷日誌顯示這類參數猜錯是最大單一失敗類別之一。
            oneOf: [
              { required: ["observations"] },
              { required: ["observationPrefix"] },
            ],
          },
        },
      },
      required: ["deletions"],
    },
  },
  {
    name: "aim_memory_unlink",
    annotations: destructiveAnnotations,
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
    annotations: readOnlyAnnotations,
    description: `Read all memories in a database. Returns every stored memory and their links.

FORMAT OPTIONS:
- "json" (default): Structured JSON for programmatic use
- "pretty": Human-readable text format
- "concise": Token-efficient one-line-per-entity form

DATABASE: Reads from the specified 'context' database, or master database if not specified.

LARGE GRAPHS: The full graph can be hundreds of KB and exceed what the MCP client can ingest (causing a client-side "unexpected error"). To stay small:
- Prefer includeObservations:false (and/or format:"concise") to get just the name/type + relation skeleton.
- Use offset/limit to page through entities (their observations) in batches. Relations are returned in full on every page. When paged, the output is prefixed with a "[page]" header telling you the range and the next offset.
- If you call read_all WITHOUT offset/limit and the full output would exceed the cap, the response automatically degrades to the largest first page that fits (same "[page]" header with the next offset) — keep calling with that offset to walk the whole graph. The payload stays well-formed (valid JSON in json format).
- Hard truncation with a notice remains only as a last-resort net for an explicitly requested page that still exceeds the cap (reduce limit), configurable via --max-output-chars / AIM_MAX_OUTPUT_CHARS.

EXAMPLES:
- aim_memory_read_all({}) - JSON format
- aim_memory_read_all({format: "concise", includeObservations: false}) - lightweight skeleton (recommended for large graphs)
- aim_memory_read_all({format: "concise", offset: 0, limit: 20}) - first 20 entities with observations, then call again with offset: 20
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
        includeObservations: includeObservationsProp,
        offset: {
          type: "number",
          minimum: 0,
          description: "Optional 0-based index of the first entity to return (default 0). Use with 'limit' to page through a large graph. Relations are returned in full on every page."
        },
        limit: {
          type: "number",
          minimum: 0,
          description: "Optional maximum number of entities to return in this page. Omit to return all entities (subject to the output-size cap). When provided, the response is prefixed with a '[page]' header indicating the range and the next offset to request."
        },
      },
    },
  },
  {
    name: "aim_memory_search",
    annotations: readOnlyAnnotations,
    description: `Search memories by keyword. Use this when you don't know the exact name of what you're looking for.

WHAT IT SEARCHES: Matches query (case-insensitive) against:
- Memory names (e.g., "John" matches "John_Smith")
- Memory types (e.g., "person" matches all person memories)
- Facts/observations (e.g., "Seattle" matches memories mentioning Seattle)

VS aim_memory_get: Use aim_memory_search for fuzzy matching. Use aim_memory_get when you know exact names.

FORMAT OPTIONS:
- "json" (default): Structured JSON for programmatic use
- "pretty": Human-readable text format
- "concise": Token-efficient one-line-per-entity form

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
        limit: {
          type: "number",
          minimum: 0,
          description: "Optional cap on the number of highest-ranked matching entities (seeds) to return. Results are ranked by relevance (exact name > name substring > type > observation). Neighbours pulled in by 'depth' do not count against this cap. Omit to return all matches."
        },
        depth: {
          type: "number",
          minimum: 0,
          description: "Optional number of relationship hops to expand from each matched entity, pulling in connected neighbours for context (default 1). Use 0 to return only the matched entities and the relations strictly between them."
        },
        format: formatProp,
      },
      required: ["query"],
    },
  },
  {
    name: "aim_memory_get",
    annotations: readOnlyAnnotations,
    description: `Retrieve specific memories by exact name. Use this when you know exactly what you're looking for.

VS aim_memory_search: Use aim_memory_get for exact name lookup. Use aim_memory_search for fuzzy matching or when you don't know exact names.

OBSERVATION FILTER (optional, at most one):
- observationPrefix: keep only observations starting with this text
- observationSubstring: keep only observations containing this text
When a filter is active, each returned entity contains only the matching observations (entities with 0 matches are kept with empty observations, so "no match" is distinguishable from "no such entity"), and the output is prefixed with an "[obs-filter]" header reporting matched/total counts. Ideal for inspecting or verifying prefix-scoped blocks (e.g. session logs) without pulling a whole large entity that could hit the output cap.

RETURNS: Requested entities and relations between them. Non-existent names are silently ignored.

FORMAT OPTIONS:
- "json" (default): Structured JSON for programmatic use
- "pretty": Human-readable text format
- "concise": Token-efficient one-line-per-entity form

EXAMPLES:
- aim_memory_get({names: ["John", "TechConf2024"]}) - JSON format
- aim_memory_get({names: ["Shane"], format: "pretty"}) - Human-readable
- aim_memory_get({names: ["Log"], observationPrefix: "session "}) - only session-prefixed observations
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
        includeObservations: includeObservationsProp,
        observationPrefix: {
          type: "string",
          description: "Optional. Keep only observations starting with this text. Provide at most one of observationPrefix or observationSubstring."
        },
        observationSubstring: {
          type: "string",
          description: "Optional. Keep only observations containing this text. Provide at most one of observationPrefix or observationSubstring."
        },
      },
      required: ["names"],
      // 兩者皆可省略，故正確的表達是「不得同時出現」，而非 oneOf（後者會要求必須有一個）。
      not: { required: ["observationPrefix", "observationSubstring"] },
    },
  },
  {
    name: "aim_memory_count_observations",
    annotations: readOnlyAnnotations,
    description: `Count observations on given entities by prefix - read-only, returns counts instead of observation bodies.

WHY: Deciding whether a prefix-scoped block needs pruning (e.g. "how many session blocks does this SessionLog have, and what are their timestamps?") should not require pulling full observation text - a large entity can hit the output cap. This tool answers the counting question directly with a tiny payload.

PARAMS:
- names: entities to inspect (required)
- observationPrefix: only count observations starting with this prefix (required)
- groupByDelimiter (optional): group matched observations by their text from the start through the FIRST occurrence of this delimiter (inclusive). E.g. observationPrefix "session " + groupByDelimiter "｜" yields one group per "session <timestamp>｜" block. Matched observations lacking the delimiter group under their full text.

RETURNS: Array of {entityName, entityExists, totalObservations, matched, groups?}:
- totalObservations: all observations on the entity (unfiltered)
- matched: observations starting with the prefix
- groups: [{key, count}] sorted by key - only present when groupByDelimiter is given
- entityExists:false -> totalObservations/matched are 0 (no such entity; other names still processed)

EXAMPLES:
- aim_memory_count_observations({names: ["Log"], observationPrefix: "session "})
- aim_memory_count_observations({names: ["Log"], observationPrefix: "session ", groupByDelimiter: "｜"})`,
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: projectRootProp,
        context: {
          type: "string",
          description: "Optional memory context. Counts observations in the specified context's knowledge graph, or the master database if not specified."
        },
        location: locationProp,
        names: {
          type: "array",
          items: { type: "string" },
          description: "An array of entity names to inspect",
        },
        observationPrefix: {
          type: "string",
          description: "Only count observations starting with this prefix.",
        },
        groupByDelimiter: {
          type: "string",
          description: "Optional. Group matched observations by their text up to and including the first occurrence of this delimiter (e.g. '｜').",
        },
      },
      required: ["names", "observationPrefix"],
    },
  },
  {
    name: "aim_memory_list_stores",
    annotations: readOnlyAnnotations,
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
  {
    name: "aim_memory_update_entity",
    annotations: destructiveNonIdempotentAnnotations,
    description: `Update a memory entity in place: rename it and/or change its entityType, without losing observations.

WHY: Renaming or retyping via forget + re-store would drop the entity's relations and force re-transcribing every observation. This tool preserves observations (order unchanged) and, on rename, rewrites every relation endpoint (from/to) that pointed at the old name.

RULES:
- Provide at least one of newName or entityType.
- Renaming onto a name that already exists is rejected (no overwrite).
- The target entity must exist.

RETURNS: The updated entity.

EXAMPLES:
- Rename: aim_memory_update_entity({name: "OldName", newName: "NewName"})
- Retype: aim_memory_update_entity({name: "Plan", entityType: "dev-plan"})
- Both: aim_memory_update_entity({context: "work", name: "Plan", newName: "Q4Plan", entityType: "dev-plan"})`,
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: projectRootProp,
        context: {
          type: "string",
          description: "Optional memory context. The entity is updated in the specified context's knowledge graph."
        },
        location: locationProp,
        name: { type: "string", description: "The current name of the entity to update" },
        newName: { type: "string", description: "Optional new name. On rename, all relation endpoints pointing at the old name are rewritten. Must not collide with an existing entity." },
        entityType: { type: "string", description: "Optional new entityType." },
      },
      required: ["name"],
    },
  },
  {
    name: "aim_memory_replace_fact",
    annotations: destructiveAnnotations,
    description: `Atomically replace matching observations on an entity with a single new observation ("delete old, add new" in one write).

WHY: Key-style observations (e.g. "開發計畫編號: ...") get superseded by newer versions. Doing this by hand needs an exact-string remove_facts + add_facts (two steps); long strings fail to match and silently no-op. This tool deletes ALL observations matching a prefix OR substring and appends newText in the same write.

MATCH: Provide exactly one of matchExact, matchPrefix or matchSubstring. Prefer matchExact when you know the current wording - matchSubstring over-matches ("狀態: 好" also hits "狀態: 好極了" and would delete both).

RETURNS: {matched: number, replaced: boolean}. If 0 observations match, nothing is appended and it returns {matched: 0, replaced: false} (never a silent no-op). Errors if the entity does not exist.

EXAMPLES:
- aim_memory_replace_fact({entityName: "R", matchExact: "版本: v1", newText: "版本: v2"})
- aim_memory_replace_fact({entityName: "Plan", matchPrefix: "開發計畫編號:", newText: "開發計畫編號: v4"})
- aim_memory_replace_fact({context: "work", entityName: "E", matchSubstring: "status is", newText: "status is green"})`,
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: projectRootProp,
        context: {
          type: "string",
          description: "Optional memory context. The observation is replaced within the specified context's knowledge graph."
        },
        location: locationProp,
        entityName: { type: "string", description: "The name of the entity whose observations to replace" },
        matchExact: { type: "string", description: "Replace the observation whose text is exactly this. Use this when you know the current wording and want to supersede it. Provide exactly one of matchExact, matchPrefix or matchSubstring." },
        matchPrefix: { type: "string", description: "Delete every observation that starts with this prefix. Provide exactly one of matchExact, matchPrefix or matchSubstring." },
        matchSubstring: { type: "string", description: "Delete every observation that contains this substring. Provide exactly one of matchExact, matchPrefix or matchSubstring." },
        newText: { type: "string", description: "The single new observation to append after deleting matches." },
      },
      required: ["entityName", "newText"],
      // 見 remove_facts 的同款註釋：恰擇一的約束必須對外可見。
      oneOf: [
        { required: ["matchExact"] },
        { required: ["matchPrefix"] },
        { required: ["matchSubstring"] },
      ],
    },
  },
  {
    name: "aim_memory_doctor",
    annotations: readOnlyAnnotations,
    description: `Read-only graph audit. Reports structural issues in a single database so you can clean them up.

RETURNS an object with:
- orphans: entity names with no relation at all
- danglingRelations: relations whose 'from'/'to' endpoint entity does not exist
- typeCollisions: groups of entityTypes that differ only by case/underscore/hyphen (e.g. dev_plan vs dev-plan vs DevPlan)
- duplicateCandidates: within one entity, observations sharing a key prefix (possible stale versions), as {entityName, keyPrefix, count, excerpts} - count exact, excerpts sample at most 3 at 120 chars each. ':' and full-width '：' both separate. A legitimately multi-valued key (several "service: ..." lines) looks identical and is reported too, so judge a group before acting; use get({names, observationPrefix}) for full bodies
- journalEntities: entities drifting from a state store into a work journal, as {entityName, datedKeys, totalObservations, sameSlotGroups:[{slot, count, keyPrefixes}]}. A dated key head is new on every write, so nothing supersedes it and nothing detects the pile-up. Listed on 5+ dated keys, or when two keys collapse to one slot after stripping the date - that pair is a same-fact duplicate duplicateCandidates cannot see, because every key is unique. Fix: keep the current value as one dateless slot via add_facts.upsertKeyed, then prune each superseded keyPrefix via remove_facts.observationPrefix, or move it to the session log if the history matters
- unresolvedMarkers: observations still carrying TODO / TBD / 待確認 / 待驗證 / 待定 / 待補 / 暫定, as {entityName, count, markers, excerpts} (same sampling). These were recorded while something was undecided, and nobody returns to update them once it is settled. Re-check each: settled -> upsertKeyed the slot; still open -> leave it; obsolete -> remove_facts
- SessionLog entities are exempt from those three checks: a session log is a journal whose pending blocks are meant to list open items, so all three would fire every time, and a signal that always fires is not a signal. The block-retention cap governs its size instead
- oversizedEntities: entities whose observation count (>=50) or total observation characters (>=10,000) reach curation thresholds, sorted by totalChars descending. Advisory only: such hub entities eat a large share of the output budget whenever search/get matches them - split them into smaller entities or prune stale observations
- stats: entity/relation/observation counts and per-entityType distribution for the audited database

This never mutates the graph and never exposes secrets beyond what is already stored.

EXAMPLES:
- aim_memory_doctor({}) - audit the default database
- aim_memory_doctor({context: "work"}) - audit the work database`,
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: projectRootProp,
        context: {
          type: "string",
          description: "Optional memory context. Audits the specified context's knowledge graph, or the master database if not specified."
        },
        location: locationProp,
      },
    },
  },
  {
    name: "aim_memory_list_entity_types",
    annotations: readOnlyAnnotations,
    description: `Read-only. List every entityType in a database with the number of entities of that type, most frequent first.

Useful for entityType vocabulary governance: spotting near-duplicate or inconsistent types before they proliferate (pair with aim_memory_doctor's typeCollisions).

RETURNS: Array of {entityType, count}.

EXAMPLES:
- aim_memory_list_entity_types({})
- aim_memory_list_entity_types({context: "work"})`,
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: projectRootProp,
        context: {
          type: "string",
          description: "Optional memory context. Lists entity types from the specified context's knowledge graph, or the master database if not specified."
        },
        location: locationProp,
      },
    },
  },
];

// ── 名稱 alias：接受呼叫端實測會用的變體，canonical 保持與上游相容 ──
//
// 為何需要：55 筆真實拒絕紀錄逐筆分類後，75% 是名稱問題而非能力問題。
// 官方 memory server 的參數名（names / entityNames / observations / deletions / query /
// entities）與本 fork **完全一致**，故 canonical 刻意不改——改成第三套詞彙只會讓模型的
// 生態先驗失效。alias 只做「接受」：命中時回應前置 [alias] 抬頭告知正名，
// 不製造隱藏契約，且模型在同一 session 內就學會。
//
// ⚠️ 新增工具時，若它對應某個上游工具，請一併在此登記，否則模型的先驗會持續打空。

// 工具名 alias。左為呼叫端實際送來的（或上游官方的）名稱，右為本 fork 的 canonical。
// 無前綴形式不必列：resolveToolName 會自動補 aim_memory_ 前綴後再查一次。
export const TOOL_NAME_ALIASES: Record<string, string> = {
  // 上游官方 MCP memory server 的九個工具名（實測 search_nodes ×9、open_nodes ×1）
  aim_memory_create_entities: 'aim_memory_store',
  aim_memory_create_relations: 'aim_memory_link',
  aim_memory_add_observations: 'aim_memory_add_facts',
  aim_memory_delete_entities: 'aim_memory_forget',
  aim_memory_delete_observations: 'aim_memory_remove_facts',
  aim_memory_delete_relations: 'aim_memory_unlink',
  aim_memory_read_graph: 'aim_memory_read_all',
  aim_memory_search_nodes: 'aim_memory_search',
  aim_memory_open_nodes: 'aim_memory_get',
  // `recall` 不是上游名也不是本 fork 名——它是 memory-graph-curation skill 的 phase 名
  // （phase=recall 意為「讀完整張圖」），被呼叫端當成工具名（實測 ×6）。對回 read_all
  // 語義正確且唯讀，猜錯的代價只是多讀不是誤寫。
  aim_memory_recall: 'aim_memory_read_all',
  aim_memory_read: 'aim_memory_read_all',
};

// 參數名 alias（per tool）。左為呼叫端送來的，右為 canonical。
// 只登記語義**明確等價**者；語義有歧義的一律不登記（讓正常的缺參數錯誤發生，附 did-you-mean）。
export const PARAM_ALIASES: Record<string, Record<string, string>> = {
  // 單一實體是 get 最常見的用法，複數陣列與直覺相衝（實測 name ×11）；
  // entityName 則是同一 server 內 add_facts / remove_facts / replace_fact 的詞彙（×3）。
  aim_memory_get: { name: 'names', entityName: 'names', entityNames: 'names' },
  aim_memory_count_observations: { name: 'names', entityName: 'names', entityNames: 'names' },
  // forget 用 entityNames（與上游 delete_entities 一致），呼叫端常寫 get 的 names（×2）。
  aim_memory_forget: { names: 'entityNames', name: 'entityNames', entityName: 'entityNames' },
  aim_memory_search: { search: 'query', q: 'query', text: 'query', keyword: 'query' },
  // 工具名說 facts、參數卻叫 observations，於是呼叫端跟著工具名寫（×1）。
  aim_memory_add_facts: { facts: 'observations' },
  aim_memory_remove_facts: { facts: 'deletions', observations: 'deletions' },
  // replace_fact 不存在於上游，呼叫端自創 old*/new*（×6）。old* 的語義是「這段原文」
  // → matchExact（新增的能力），拿 matchSubstring 硬代替會過度命中。
  aim_memory_replace_fact: {
    oldFact: 'matchExact',
    oldObservation: 'matchExact',
    oldText: 'matchExact',
    newFact: 'newText',
    newObservation: 'newText',
  },
};

// Workspace-only 嚴格模式：對外公告的 schema 需與執行時的 fail-closed 行為一致，
// 否則模型會照著描述送出被拒絕的 global 呼叫。因此在此模式下：
//   1. 將 projectRoot 標記為每個工具必填（提示層；實際強制在 storage.ts）。
//   2. 移除 location 屬性 —— global 被停用、project 在有 projectRoot 時多餘。
//   3. 刪掉描述中所有 global/location 的說明與範例，因為那些功能在此模式下不存在。
//   4. projectRoot 的描述換成精簡版，並於描述最前面加簡短公告。
//
// ⚠️ 這裡的字元數是**每個 session 的固定成本**：工具清單隨每次連線送進模型 context，
// 15 個工具共用的片段每省 1 字元就省 15 字元。原始版本有約 9,400 字元屬機械性重複
// （projectRoot 描述 349×15、公告 217×15、以及 6 行已停用功能的範例），
// 遠大於一個專案記憶本身的召回量，故在此一次性壓縮。行為性指引不在削減範圍。
if (workspaceOnly) {
  const note = "[workspace-only mode] Pass projectRoot = the current workspace's absolute root path on every call.\n\n";
  const conciseProjectRoot = {
    type: "string",
    description: "Absolute path to the current workspace root; memory lives in <projectRoot>/.aim/. Required.",
  };
  // 已停用功能的殘留文字：location 段落、以及提及 global/project location 的範例行。
  const deadLine = /^(LOCATION OVERRIDE:|- (?:Master|Work|Personal|Global)[^\n]*\bin (?:global|project) location:)/;
  for (const tool of TOOL_DEFINITIONS) {
    const schema = tool.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
    schema.required = Array.from(new Set([...(schema.required ?? []), "projectRoot"]));
    if (schema.properties) {
      delete schema.properties.location;
      if (schema.properties.projectRoot) schema.properties.projectRoot = conciseProjectRoot;
    }
    const body = (tool.description ?? "")
      .split("\n")
      .filter(line => !deadLine.test(line.trim()))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    tool.description = note + body;
  }
}
