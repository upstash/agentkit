import { tool, type Tool, type ToolExecutionOptions, type ToolSet } from "ai";
import { ToolCache } from "@upstash/agentkit-sdk";
import { Redis } from "@upstash/redis";

/** The cache key for a tool call: a fixed string, or a function of the tool input + call options. */
export type CacheNamespace<INPUT> =
  | string
  | ((input: INPUT, options: ToolExecutionOptions<never>) => string);

/** The Upstash cache options merged into an AI SDK `tool()` config. */
export interface CacheOptions<INPUT> {
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /** Cache key — a string, or a function of the tool input + options (e.g. to scope by user). */
  namespace: CacheNamespace<INPUT>;
  /** Per-result TTL (seconds). */
  ttlSeconds?: number;
}

/**
 * A {@link cachedTool} config: every field of the AI SDK's `tool()` (so `inputSchema`, `execute`,
 * `outputSchema`, … all infer exactly as they do there) plus the Upstash cache options.
 */
export type CachedToolConfig<INPUT, OUTPUT> = Tool<INPUT, OUTPUT> & CacheOptions<INPUT>;

/** Wrap a `Tool`'s `execute` so its result is memoized in `cache` under `namespace` + input hash. */
function withCache<INPUT, OUTPUT>(
  cache: ToolCache,
  namespace: CacheNamespace<INPUT>,
  ttlSeconds: number | undefined,
  config: Tool<INPUT, OUTPUT>,
): Tool<INPUT, OUTPUT> {
  const original = config.execute as
    | ((input: INPUT, options: ToolExecutionOptions<never>) => OUTPUT | PromiseLike<OUTPUT>)
    | undefined;

  const execute = (input: INPUT, options: ToolExecutionOptions<never>): PromiseLike<OUTPUT> => {
    const name = typeof namespace === "function" ? namespace(input, options) : namespace;
    const run = cache.wrap<INPUT, OUTPUT>(
      name,
      (i) => Promise.resolve(original!(i, options)),
      ttlSeconds !== undefined ? { ttlSeconds } : {},
    );
    return run(input);
  };

  return tool({ ...config, execute } as Tool<INPUT, OUTPUT>) as Tool<INPUT, OUTPUT>;
}

/**
 * Like the AI SDK's `tool()`, but the tool's `execute` is memoized in an Upstash {@link ToolCache} —
 * self-contained, so you don't import anything from the core SDK. `redis` defaults to
 * `Redis.fromEnv()`. Cache keys are `agentkit:toolCache:<namespace>:<hash-of-input>`.
 *
 * ```ts
 * import { generateText } from "ai";
 * import { cachedTool } from "@upstash/agentkit-ai-sdk";
 *
 * const getWeather = cachedTool({
 *   description: "Get the weather for a city",
 *   inputSchema: z.object({ city: z.string() }),
 *   namespace: "getWeather",
 *   execute: async ({ city }) => fetchWeather(city), // `city` is inferred from inputSchema
 * });
 * await generateText({ model, tools: { getWeather }, prompt: "What's the weather in Paris?" });
 * ```
 */
export function cachedTool<INPUT, OUTPUT>(
  config: CachedToolConfig<INPUT, OUTPUT>,
): Tool<INPUT, OUTPUT> {
  const { redis, namespace, ttlSeconds, ...toolConfig } = config;
  const cache = new ToolCache({ redis: redis ?? Redis.fromEnv() });
  return withCache(cache, namespace, ttlSeconds, toolConfig as Tool<INPUT, OUTPUT>);
}

export interface CachedToolsOptions {
  /** Upstash Redis client shared by every tool. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /** Default per-result TTL (seconds) for every cached tool. */
  ttlSeconds?: number;
}

/** Wrap an already-built `Tool`'s `execute` with caching, keyed by `namespace` + input hash. */
function wrapBuiltTool(
  cache: ToolCache,
  namespace: string,
  ttlSeconds: number | undefined,
  built: Tool,
): Tool {
  const original = built.execute as
    | ((input: unknown, options: ToolExecutionOptions<never>) => unknown)
    | undefined;
  if (!original) return built;

  const execute = (input: unknown, options: ToolExecutionOptions<never>): Promise<unknown> => {
    const run = cache.wrap(
      namespace,
      (i: unknown) => Promise.resolve(original(i, options)),
      ttlSeconds !== undefined ? { ttlSeconds } : {},
    );
    return run(input);
  };

  return tool({ ...built, execute } as never) as Tool;
}

/**
 * Cache a whole map of AI SDK tools at once. Pass tools built with the AI SDK's `tool()` (so each one
 * keeps full input/output type inference) — every tool's `execute` is memoized in Redis, keyed by its
 * map key, so you don't repeat a `namespace`. Returns the same map shape, ready for `generateText`.
 *
 * ```ts
 * import { generateText, tool } from "ai";
 * import { cachedTools } from "@upstash/agentkit-ai-sdk";
 *
 * const tools = cachedTools({
 *   getWeather: tool({
 *     description: "Get the weather for a city",
 *     inputSchema: z.object({ city: z.string() }),
 *     execute: async ({ city }) => fetchWeather(city), // `city` is inferred; cached under "getWeather"
 *   }),
 * });
 * await generateText({ model, tools, prompt: "What's the weather in Paris?" });
 * ```
 */
export function cachedTools<T extends ToolSet>(tools: T, options: CachedToolsOptions = {}): T {
  const cache = new ToolCache({ redis: options.redis ?? Redis.fromEnv() });
  const out = {} as Record<string, Tool>;
  for (const [name, built] of Object.entries(tools)) {
    out[name] = wrapBuiltTool(cache, name, options.ttlSeconds, built);
  }
  return out as T;
}
