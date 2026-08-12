import { ToolCache } from "@upstash/agentkit-sdk";
import { Redis } from "@upstash/redis";
import { defineTool } from "eve/tools";
import type { ToolContext, ToolDefinition } from "eve/tools";

/** The user a cache entry is scoped to: a fixed string, or a function of the tool input + context. */
export type CacheUserId<TInput> = string | ((input: TInput, ctx: ToolContext) => string);

/**
 * A {@link ToolDefinition} whose `execute` is known to resolve to `TOutput` — never an
 * `AsyncIterable` of output snapshots (eve ≥0.31 lets executors stream; ours never do).
 * What the agentkit tool factories return, so direct `execute` calls stay awaitable.
 */
export type ResolvedToolDefinition<TInput, TOutput> = Omit<
  ToolDefinition<TInput, TOutput>,
  "execute"
> & {
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>;
};

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
 * A cached tool does not stream: if `execute` is an async generator (eve ≥0.31's preliminary output
 * snapshots), it is drained and only the final snapshot is cached and returned — a cache hit could
 * never replay the intermediate snapshots anyway.
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
): ResolvedToolDefinition<TInput, TOutput> {
  const { redis, toolName, userId, ttlSeconds, execute, ...rest } = config;
  const cache = new ToolCache({ redis: redis ?? Redis.fromEnv() });

  return defineTool({
    ...rest,
    execute: (input: TInput, ctx: ToolContext) => {
      const resolvedUserId = typeof userId === "function" ? userId(input, ctx) : userId;
      const run = cache.wrap<TInput, TOutput>(
        resolvedUserId,
        toolName,
        async (i) => finalSnapshot(await execute(i, ctx)),
        ttlSeconds !== undefined ? { ttlSeconds } : {},
      );
      return run(input);
    },
  } as Parameters<typeof defineTool>[0]) as ResolvedToolDefinition<TInput, TOutput>;
}

function isAsyncIterable<T>(value: T | AsyncIterable<T>): value is AsyncIterable<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
  );
}

/** Resolve an eve ≥0.31 streaming `execute` result to the value to cache: its last yielded snapshot. */
async function finalSnapshot<TOutput>(result: TOutput | AsyncIterable<TOutput>): Promise<TOutput> {
  if (!isAsyncIterable(result)) return result;
  let last: TOutput | undefined;
  let yielded = false;
  for await (const snapshot of result) {
    last = snapshot;
    yielded = true;
  }
  if (!yielded) {
    throw new Error("defineCachedTool: streaming execute completed without yielding a result");
  }
  return last as TOutput;
}
