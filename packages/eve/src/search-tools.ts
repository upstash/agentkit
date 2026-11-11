import {
  createSearchToolDefs,
  type SearchToolDef,
  type SearchToolDefsConfig,
} from "@upstash/agentkit-sdk";
import { Redis } from "@upstash/redis";
import { defineTool } from "eve/tools";
import type { ToolDefinition } from "eve/tools";
import { addTelemetry } from "./telemetry.js";

export interface DefineSearchToolsConfig extends Omit<SearchToolDefsConfig, "redis"> {
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /**
   * eve tool `label` per tool — the activity text channels show for a call (`{ start(input) }`),
   * or `false` (eve ≥ 1.0.0-rc.7) to keep the call out of activity. Omitted, eve shows the tool's
   * name.
   */
  labels?: Partial<Record<keyof SearchToolSet, ToolDefinition["label"]>>;
}

/** The three eve search tools over one index, each already `defineTool`-branded. */
export interface SearchToolSet {
  search: ToolDefinition;
  aggregate: ToolDefinition;
  count: ToolDefinition;
}

function wrap(def: SearchToolDef, label: ToolDefinition["label"]): ToolDefinition {
  return defineTool({
    ...(label !== undefined ? { label } : {}),
    description: def.description,
    inputSchema: def.inputSchema,
    execute: (input: Record<string, unknown>) => def.execute(input),
  } as Parameters<typeof defineTool>[0]) as ToolDefinition;
}

/**
 * Build eve `search` / `aggregate` / `count` tools over an Upstash Redis Search index, the eve
 * counterpart to the AI SDK adapter's `createSearchTools`. Returns a record of ready (already
 * `defineTool`-branded) tools; the index is created on first use (reactively). `redis` defaults to env.
 *
 * eve snapshots each tool file and resolves only **package** imports, so every `agent/tools/*.ts` file
 * must be self-contained: call `defineSearchTools` in each file and export the member you want, repeating
 * the same `schema` + `indexName` across them. Don't import a shared `agent/` module (e.g. a
 * `../redis.js` or `../lib/book-search.js`) — it fails at the turn step with `Cannot find module`. Omit
 * `redis` so it defaults to `Redis.fromEnv()`.
 *
 * ```ts
 * // agent/tools/search_books.ts
 * import { s } from "@upstash/redis";
 * import { defineSearchTools } from "@upstash/agentkit-eve";
 *
 * export default defineSearchTools({
 *   schema: s.object({ title: s.string(), author: s.string().noTokenize(), year: s.number() }),
 *   indexName: "books",
 * }).search; // aggregate_books.ts → .aggregate, count_books.ts → .count (repeat schema + indexName)
 * ```
 */
export function defineSearchTools(config: DefineSearchToolsConfig): SearchToolSet {
  const { redis, labels, ...rest } = config;
  const client = redis ?? Redis.fromEnv();
  addTelemetry(client, rest.enableTelemetry);
  const defs = createSearchToolDefs({ redis: client, ...rest });
  return {
    search: wrap(defs.search, labels?.search),
    aggregate: wrap(defs.aggregate, labels?.aggregate),
    count: wrap(defs.count, labels?.count),
  };
}
