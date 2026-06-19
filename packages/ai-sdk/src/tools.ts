import { tool, type Tool, type ToolExecutionOptions } from "ai";
import { ToolCache } from "@upstash/agentkit-sdk";
import { Redis } from "@upstash/redis";

/** The cache key for a tool call: a fixed string, or a function of the tool input + call options. */
export type CachePrefix =
  | string
  | ((input: unknown, options: ToolExecutionOptions<never>) => string);

export interface CachedToolConfig {
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /** Pre-built tool cache (overrides `redis`). */
  toolCache?: ToolCache;
  /** Cache key — a string, or a function of the tool input + options (e.g. to scope by user). */
  cachePrefix: CachePrefix;
  /** Per-result TTL (seconds). */
  ttlSeconds?: number;
  /** Tool description shown to the model. */
  description?: string;
  /** The tool's input schema (zod or any Standard Schema). */
  inputSchema: unknown;
  /** The tool implementation. Memoized by `cachePrefix` + a stable hash of the input. */
  execute: (input: never, options: ToolExecutionOptions<never>) => unknown;
  /** Any other AI SDK `tool()` fields (e.g. `outputSchema`, `toModelOutput`). */
  [key: string]: unknown;
}

/**
 * Like the AI SDK's `tool()`, but the tool's `execute` is memoized in an Upstash {@link ToolCache} —
 * self-contained, so you don't import anything from the core SDK. `redis` defaults to
 * `Redis.fromEnv()`.
 *
 * ```ts
 * import { cachedTool } from "@upstash/agentkit-ai-sdk";
 *
 * const getWeather = cachedTool({
 *   description: "Get the weather for a city",
 *   inputSchema: z.object({ city: z.string() }),
 *   cachePrefix: "getWeather",
 *   execute: async ({ city }) => fetchWeather(city),
 * });
 * await generateText({ model, tools: { getWeather }, prompt });
 * ```
 */
export function cachedTool(config: CachedToolConfig): Tool {
  const { redis, toolCache, ttlSeconds, cachePrefix, execute, ...toolConfig } = config;
  const cache = toolCache ?? new ToolCache({ redis: redis ?? Redis.fromEnv() });

  const wrapped = (input: unknown, options: ToolExecutionOptions<never>): unknown => {
    const name = typeof cachePrefix === "function" ? cachePrefix(input, options) : cachePrefix;
    const run = cache.wrap(
      name,
      (i: unknown) =>
        Promise.resolve(
          (execute as (i: unknown, o: ToolExecutionOptions<never>) => unknown)(i, options),
        ),
      ttlSeconds !== undefined ? { ttlSeconds } : {},
    );
    return run(input);
  };

  return tool({ ...toolConfig, execute: wrapped } as never) as Tool;
}
