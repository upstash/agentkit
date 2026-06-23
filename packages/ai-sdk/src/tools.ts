import { tool, type Tool, type ToolExecutionOptions, type ToolSet } from "ai";
import { ToolCache } from "@upstash/agentkit-sdk";
import { Redis } from "@upstash/redis";

/** The user a cache entry is scoped to: a fixed string, or a function of the tool input + options. */
export type CacheUserId<INPUT> =
  | string
  | ((input: INPUT, options: ToolExecutionOptions<never>) => string);

export interface CachedToolsOptions {
  /** The user the cache entries are scoped to — a string, or a per-call function. */
  userId: CacheUserId<unknown>;
  /** Upstash Redis client shared by every tool. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /** Default per-result TTL (seconds) for every cached tool. */
  ttlSeconds?: number;
}

/** Wrap an already-built `Tool`'s `execute` with caching, keyed by `userId` + `toolName` + hash. */
function wrapBuiltTool(
  cache: ToolCache,
  toolName: string,
  userId: CacheUserId<unknown>,
  ttlSeconds: number | undefined,
  built: Tool,
): Tool {
  const original = built.execute as
    | ((input: unknown, options: ToolExecutionOptions<never>) => unknown)
    | undefined;
  if (!original) return built;

  const execute = (input: unknown, options: ToolExecutionOptions<never>): Promise<unknown> => {
    const resolvedUserId = typeof userId === "function" ? userId(input, options) : userId;
    const run = cache.wrap(
      resolvedUserId,
      toolName,
      (i: unknown) => Promise.resolve(original(i, options)),
      ttlSeconds !== undefined ? { ttlSeconds } : {},
    );
    return run(input);
  };

  return tool({ ...built, execute } as never) as Tool;
}

/**
 * Cache a whole map of AI SDK tools at once. Pass tools built with the AI SDK's `tool()` (so each one
 * keeps full input/output type inference) — every tool's `execute` is memoized in Redis under its map
 * key as the `toolName`, scoped to `userId`. Returns the same map shape, ready for `generateText`.
 *
 * ```ts
 * import { generateText, tool } from "ai";
 * import { cachedTools } from "@upstash/agentkit-ai-sdk";
 *
 * const tools = cachedTools(
 *   {
 *     getWeather: tool({
 *       description: "Get the weather for a city",
 *       inputSchema: z.object({ city: z.string() }),
 *       execute: async ({ city }) => fetchWeather(city), // cached under "getWeather"
 *     }),
 *   },
 *   { userId }, // scope every entry to this user
 * );
 * await generateText({ model, tools, prompt: "What's the weather in Paris?" });
 * ```
 */
export function cachedTools<T extends ToolSet>(tools: T, options: CachedToolsOptions): T {
  const cache = new ToolCache({ redis: options.redis ?? Redis.fromEnv() });
  const out = {} as Record<string, Tool>;
  for (const [name, built] of Object.entries(tools)) {
    out[name] = wrapBuiltTool(cache, name, options.userId, options.ttlSeconds, built);
  }
  return out as T;
}
