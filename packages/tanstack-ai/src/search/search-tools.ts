import type { Redis } from "@upstash/redis";
import { Redis as RedisClient } from "@upstash/redis";
import { createSearchToolDefs } from "@upstash/agentkit-sdk";
import type { AnySearchSchema, SearchToolDefsConfig } from "@upstash/agentkit-sdk";
import { toolDefinition } from "@tanstack/ai";
import type { Tool } from "@tanstack/ai";
import { addTelemetry } from "../telemetry.js";

/**
 * The core {@link SearchToolDefsConfig} (`schema`, `indexName`, `prefix`, `defaultLimit`,
 * `enableTelemetry`), with `redis` optional, plus the tool names.
 */
export type CreateSearchToolsConfig<TSchema extends AnySearchSchema = AnySearchSchema> = Omit<
  SearchToolDefsConfig<TSchema>,
  "redis"
> & {
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /** Tool names. Defaults to `search`, `aggregate` and `count`. */
  names?: { search?: string; aggregate?: string; count?: string };
};

/**
 * Schema-driven Redis Search tools for TanStack AI — `search`, `aggregate` and `count` over one
 * Upstash Redis Search index, for RAG over your own documents. The tool descriptions are generated
 * from the schema (fields, types, and the operators each accepts), and the index is created on the
 * first read. Returns server tools ready for `chat({ tools })`.
 *
 * ```ts
 * const tools = createSearchTools({
 *   indexName: "products",
 *   schema: s.object({ name: s.string(), price: s.number(), inStock: s.boolean() }),
 * });
 * chat({ adapter, messages, tools });
 * ```
 */
export function createSearchTools<TSchema extends AnySearchSchema = AnySearchSchema>(
  config: CreateSearchToolsConfig<TSchema>,
): Tool[] {
  const redis = config.redis ?? RedisClient.fromEnv();
  addTelemetry(redis, config.enableTelemetry);
  const { names: toolNames, ...defsConfig } = config;
  const defs = createSearchToolDefs({ ...defsConfig, redis });
  const names = { search: "search", aggregate: "aggregate", count: "count", ...toolNames };
  return (["search", "aggregate", "count"] as const).map((key) =>
    toolDefinition({
      name: names[key],
      description: defs[key].description,
      inputSchema: defs[key].inputSchema,
    }).server(async (input: unknown) => defs[key].execute(input as Record<string, unknown>)),
  );
}
