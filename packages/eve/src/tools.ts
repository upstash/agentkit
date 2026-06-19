import { ToolCache } from "@upstash/agentkit-sdk";
import { Redis } from "@upstash/redis";
import type { ToolContext, ToolDefinition } from "eve/tools";

/** The cache key for a tool call: a fixed string, or a function of the tool input + context. */
export type CacheNamespace<TInput> = string | ((input: TInput, ctx: ToolContext) => string);

export type DefineCachedToolConfig<TInput, TOutput> = ToolDefinition<TInput, TOutput> & {
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /** Pre-built tool cache (overrides `redis`). */
  toolCache?: ToolCache;
  /** Cache key — a string, or a function of the tool input + context (e.g. to scope by user). */
  namespace: CacheNamespace<TInput>;
  /** Per-result TTL (seconds). */
  ttlSeconds?: number;
};

/**
 * Like Eve's `defineTool`, but the tool's `execute` is memoized in an Upstash {@link ToolCache}.
 * Takes the same fields as `defineTool` plus `cachePrefix` (and an optional `redis`); returns a
 * `ToolDefinition` you hand to `defineTool`.
 *
 * ```ts
 * // agent/tools/get_weather.ts
 * import { defineTool } from "eve/tools";
 * import { z } from "zod";
 * import { defineCachedTool } from "@upstash/agentkit-eve";
 *
 * export default defineTool(
 *   defineCachedTool({
 *     description: "Get the current weather for a city.",
 *     inputSchema: z.object({ city: z.string() }),
 *     namespace: "get_weather",
 *     execute: async ({ city }) => fetchWeather(city),
 *   }),
 * );
 * ```
 */
export function defineCachedTool<TInput, TOutput>(
  config: DefineCachedToolConfig<TInput, TOutput>,
): ToolDefinition<TInput, TOutput> {
  const { redis, toolCache, namespace, ttlSeconds, execute, ...rest } = config;
  const cache = toolCache ?? new ToolCache({ redis: redis ?? Redis.fromEnv() });

  return {
    ...rest,
    execute: (input: TInput, ctx: ToolContext) => {
      const name = typeof namespace === "function" ? namespace(input, ctx) : namespace;
      const run = cache.wrap<TInput, TOutput>(
        name,
        (i) => Promise.resolve(execute(i, ctx)),
        ttlSeconds !== undefined ? { ttlSeconds } : {},
      );
      return run(input);
    },
  } as ToolDefinition<TInput, TOutput>;
}
