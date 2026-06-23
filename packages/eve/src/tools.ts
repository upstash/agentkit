import { ToolCache } from "@upstash/agentkit-sdk";
import { Redis } from "@upstash/redis";
import { defineTool } from "eve/tools";
import type { ToolContext, ToolDefinition } from "eve/tools";

/** The user a cache entry is scoped to: a fixed string, or a function of the tool input + context. */
export type CacheUserId<TInput> = string | ((input: TInput, ctx: ToolContext) => string);

export type DefineCachedToolConfig<TInput, TOutput> = ToolDefinition<TInput, TOutput> & {
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /** The tool name — the `toolName` segment of the cache key. */
  toolName: string;
  /** The user the cache entry is scoped to — a string, or a per-call function of input + ctx. */
  userId: CacheUserId<TInput>;
  /** Per-result TTL (seconds). */
  ttlSeconds?: number;
};

/**
 * Like Eve's `defineTool`, but the tool's `execute` is memoized in an Upstash {@link ToolCache}.
 * Takes the same fields as `defineTool` plus `toolName` and `userId` (and an optional `redis`), calls
 * `defineTool` for you, and returns the branded `ToolDefinition` — export it directly. Cache keys are
 * `agentkit:toolCache:<userId>:<toolName>:<hash-of-input>`.
 *
 * ```ts
 * // agent/tools/get_weather.ts
 * import { z } from "zod";
 * import { defineCachedTool } from "@upstash/agentkit-eve";
 *
 * export default defineCachedTool({
 *   description: "Get the current weather for a city.",
 *   inputSchema: z.object({ city: z.string() }),
 *   toolName: "get_weather",
 *   userId: (_, ctx) => ctx.session.auth.current?.principalId ?? ctx.session.id, // scope per user
 *   execute: async ({ city }) => fetchWeather(city),
 * });
 * ```
 */
export function defineCachedTool<TInput, TOutput>(
  config: DefineCachedToolConfig<TInput, TOutput>,
): ToolDefinition<TInput, TOutput> {
  const { redis, toolName, userId, ttlSeconds, execute, ...rest } = config;
  const cache = new ToolCache({ redis: redis ?? Redis.fromEnv() });

  return defineTool({
    ...rest,
    execute: (input: TInput, ctx: ToolContext) => {
      const resolvedUserId = typeof userId === "function" ? userId(input, ctx) : userId;
      const run = cache.wrap<TInput, TOutput>(
        resolvedUserId,
        toolName,
        (i) => Promise.resolve(execute(i, ctx)),
        ttlSeconds !== undefined ? { ttlSeconds } : {},
      );
      return run(input);
    },
  } as Parameters<typeof defineTool>[0]) as ToolDefinition<TInput, TOutput>;
}
