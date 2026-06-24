import {
  createSearchToolDefs,
  type SearchToolDef,
  type SearchToolDefsConfig,
} from "@upstash/agentkit-sdk";
import { Redis } from "@upstash/redis";
import { defineTool } from "eve/tools";
import type { ToolDefinition } from "eve/tools";

export interface DefineSearchToolsConfig extends Omit<SearchToolDefsConfig, "redis"> {
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
}

/** The three eve search tools over one index, each already `defineTool`-branded. */
export interface SearchToolSet {
  search: ToolDefinition;
  aggregate: ToolDefinition;
  count: ToolDefinition;
}

function wrap(def: SearchToolDef): ToolDefinition {
  return defineTool({
    description: def.description,
    inputSchema: def.inputSchema,
    execute: (input: Record<string, unknown>) => def.execute(input),
  } as Parameters<typeof defineTool>[0]) as ToolDefinition;
}

/**
 * Build eve `search` / `aggregate` / `count` tools over an Upstash Redis Search index — the eve
 * counterpart to the AI SDK adapter's `createSearchTools`. Returns a record of ready (already
 * `defineTool`-branded) tools; the index is created on first use (reactively). `redis` defaults to env.
 *
 * eve is file-centric (filename = tool name), so build the set once in `agent/lib/` and re-export each
 * tool from its own file:
 *
 * ```ts
 * // agent/lib/book-search.ts
 * import { s } from "@upstash/redis";
 * import { defineSearchTools } from "@upstash/agentkit-eve";
 * import { redis } from "../redis.js";
 *
 * export const bookSearch = defineSearchTools({
 *   schema: s.object({ title: s.string(), author: s.string().noTokenize(), year: s.number() }),
 *   indexName: "books",
 *   redis,
 * });
 * ```
 *
 * ```ts
 * // agent/tools/search_books.ts
 * import { bookSearch } from "../lib/book-search.js";
 * export default bookSearch.search; // also: aggregate_books.ts → bookSearch.aggregate, etc.
 * ```
 */
export function defineSearchTools(config: DefineSearchToolsConfig): SearchToolSet {
  const { redis, ...rest } = config;
  const defs = createSearchToolDefs({ redis: redis ?? Redis.fromEnv(), ...rest });
  return { search: wrap(defs.search), aggregate: wrap(defs.aggregate), count: wrap(defs.count) };
}
