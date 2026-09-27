import type { Redis } from "@upstash/redis";
import { Redis as RedisClient } from "@upstash/redis";
import { createSearchToolDefs } from "@upstash/agentkit-sdk";
import type { AnySearchSchema } from "@upstash/agentkit-sdk";
import { toolDefinition } from "@tanstack/ai";
import type { Tool } from "@tanstack/ai";
import { addTelemetry } from "./telemetry.js";

export interface CreateSearchToolsConfig<TSchema extends AnySearchSchema = AnySearchSchema> {
  /** The Upstash Redis Search schema of your documents (built with `s` from `@upstash/redis`). */
  schema: TSchema;
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /** Index name. Defaults to `"agentkit:search"`. */
  indexName?: string;
  /** Key prefix of the indexed JSON documents. Defaults to `"<indexName>:"`. */
  prefix?: string;
  /** Default page size for the search tool. Defaults to 10. */
  defaultLimit?: number;
  /** Tool names. Defaults to `search`, `aggregate` and `count`. */
  names?: { search?: string; aggregate?: string; count?: string };
  /**
   * Report the sdk name + version to Upstash as a header on the requests made by your redis client.
   * Can also be disabled with the `UPSTASH_DISABLE_TELEMETRY` env var. Defaults to `true`.
   */
  enableTelemetry?: boolean;
}

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
  const defs = createSearchToolDefs({
    schema: config.schema,
    redis,
    ...(config.indexName !== undefined ? { indexName: config.indexName } : {}),
    ...(config.prefix !== undefined ? { prefix: config.prefix } : {}),
    ...(config.defaultLimit !== undefined ? { defaultLimit: config.defaultLimit } : {}),
    ...(config.enableTelemetry !== undefined ? { enableTelemetry: config.enableTelemetry } : {}),
  });
  const names = { search: "search", aggregate: "aggregate", count: "count", ...config.names };
  return (["search", "aggregate", "count"] as const).map(
    (key) =>
      toolDefinition({
        name: names[key],
        description: defs[key].description,
        inputSchema: defs[key].inputSchema as never,
      }).server(async (input: unknown) =>
        defs[key].execute(input as Record<string, unknown>),
      ) as unknown as Tool,
  );
}
