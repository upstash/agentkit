import { tool, type Tool, type ToolSet } from "ai";
import { Redis } from "@upstash/redis";
import {
  createSearchToolDefs,
  type SearchToolDef,
  type SearchToolDefsConfig,
} from "@upstash/agentkit-sdk";

export interface CreateSearchToolsConfig extends Omit<SearchToolDefsConfig, "redis"> {
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
}

// The schema is a generic zod type and these tools are model-called, so inference isn't needed here.
function wrap(def: SearchToolDef): Tool {
  return tool({
    description: def.description,
    inputSchema: def.inputSchema,
    execute: def.execute,
  } as never) as Tool;
}

/**
 * Build a set of Vercel AI SDK tools that let an agent search an Upstash Redis Search index:
 * `search` (query), `aggregate`, and `count`. The tool descriptions are generated from your `schema`
 * so the model knows the available fields, their types, and which filter operators apply to each. The
 * index is created on first use (reactively) — no setup, no `ensureIndex` flag.
 *
 * ```ts
 * import { s } from "@upstash/redis";
 * import { createSearchTools } from "@upstash/agentkit-ai-sdk";
 * import { generateText, stepCountIs } from "ai";
 *
 * const schema = s.object({ name: s.string(), age: s.number() });
 * const result = await generateText({
 *   model,
 *   tools: createSearchTools({ schema, name: "users" }),
 *   stopWhen: stepCountIs(5),
 *   prompt: "Find users named Ada older than 30",
 * });
 * ```
 */
export function createSearchTools(config: CreateSearchToolsConfig): ToolSet {
  const { redis, ...rest } = config;
  const defs = createSearchToolDefs({ redis: redis ?? Redis.fromEnv(), ...rest });
  return { search: wrap(defs.search), aggregate: wrap(defs.aggregate), count: wrap(defs.count) };
}
