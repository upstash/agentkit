import type { Redis } from "@upstash/redis";
import { Redis as RedisClient } from "@upstash/redis";
import { ToolCache, createRateLimit } from "@upstash/agentkit-sdk";
import type { RateLimitConfig } from "@upstash/agentkit-sdk";
import type { ChatMiddleware, ChatMiddlewareContext } from "@tanstack/ai";
import { addTelemetry } from "./telemetry.js";

export interface ToolCacheMiddlewareConfig {
  /**
   * Names of the tools whose results may be cached. Required on purpose: only deterministic,
   * side-effect-free tools belong here (a cached `send_email` would silently stop sending).
   */
  tools: string[];
  /** The user entries are scoped to — a string, or derived from the run context. */
  userId: string | ((ctx: ChatMiddlewareContext) => string);
  /** Per-result TTL in seconds. Omit for no expiry. */
  ttlSeconds?: number;
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /** Base key prefix. Defaults to `agentkit:toolCache` (shared with the other adapters' caches). */
  prefix?: string;
  /**
   * Report the sdk name + version to Upstash as a header on the requests made by your redis client.
   * Can also be disabled with the `UPSTASH_DISABLE_TELEMETRY` env var. Defaults to `true`.
   */
  enableTelemetry?: boolean;
}

/**
 * Chat middleware that memoizes tool results in Redis, keyed by `userId` + tool name + a stable hash
 * of the arguments. A hit skips the tool entirely (`onBeforeToolCall` → `skip`); a successful miss is
 * stored after it runs. Failed calls are never cached, and a result served from the cache is not
 * re-written.
 *
 * ```ts
 * chat({
 *   adapter, messages, tools: [getWeather],
 *   middleware: [toolCache({ tools: ["get_weather"], userId, ttlSeconds: 600 })],
 * });
 * ```
 */
export function toolCache(config: ToolCacheMiddlewareConfig): ChatMiddleware {
  const redis = config.redis ?? RedisClient.fromEnv();
  addTelemetry(redis, config.enableTelemetry);
  const cache = new ToolCache({
    redis,
    ...(config.prefix !== undefined ? { prefix: config.prefix } : {}),
    ...(config.ttlSeconds !== undefined ? { ttlSeconds: config.ttlSeconds } : {}),
    ...(config.enableTelemetry !== undefined ? { enableTelemetry: config.enableTelemetry } : {}),
  });
  const allowed = new Set(config.tools);
  const resolveUserId = (ctx: ChatMiddlewareContext) =>
    typeof config.userId === "function" ? config.userId(ctx) : config.userId;
  // Calls this middleware has seen, by id: the args to key the write with, or "hit" when served.
  const pending = new Map<string, { args: unknown } | "hit">();

  return {
    name: "upstash-tool-cache",
    async onBeforeToolCall(ctx, hook) {
      if (!allowed.has(hook.toolName)) return;
      const hit = await cache.get(resolveUserId(ctx), hook.toolName, hook.args);
      if (hit) {
        pending.set(hook.toolCallId, "hit");
        return { type: "skip", result: hit.value };
      }
      pending.set(hook.toolCallId, { args: hook.args });
      return;
    },
    async onAfterToolCall(ctx, info) {
      const seen = pending.get(info.toolCallId);
      pending.delete(info.toolCallId);
      if (!seen || seen === "hit" || !info.ok || !allowed.has(info.toolName)) return;
      await cache.set(resolveUserId(ctx), info.toolName, seen.args, info.result);
    },
  };
}

/** Thrown from `onStart` when the caller is over its limit; surfaces as the run's error. */
export class RateLimitExceededError extends Error {
  constructor(
    readonly identifier: string,
    readonly limit: number,
    readonly remaining: number,
    /** Epoch ms when the window resets. */
    readonly reset: number,
  ) {
    super(
      `Rate limit exceeded for "${identifier}". Try again after ${new Date(reset).toISOString()}.`,
    );
    this.name = "RateLimitExceededError";
  }
}

export interface RateLimitMiddlewareConfig extends RateLimitConfig {
  /** Who is being limited — usually the authenticated user id, derived server-side. */
  identifier: string | ((ctx: ChatMiddlewareContext) => string | Promise<string>);
}

/**
 * Chat middleware that spends one unit of an Upstash Ratelimit per run, before the model is called,
 * and fails the run with {@link RateLimitExceededError} when the identifier is over its limit.
 *
 * To answer with an HTTP 429 instead of a streamed error, call `createRateLimit(...).limit(id)` in
 * your route before `chat()` — both are exported.
 *
 * ```ts
 * middleware: [rateLimit({ limiter: Ratelimit.slidingWindow(10, "60 s"), identifier: userId })]
 * ```
 */
export function rateLimit(config: RateLimitMiddlewareConfig): ChatMiddleware {
  const { identifier, ...limitConfig } = config;
  const limiter = createRateLimit(limitConfig);
  if (config.redis) addTelemetry(config.redis, config.enableTelemetry);
  return {
    name: "upstash-rate-limit",
    async onStart(ctx) {
      // Subagent child runs share the parent's budget; only the top-level run spends a unit.
      if (ctx.parentRunId !== undefined) return;
      const id = typeof identifier === "function" ? await identifier(ctx) : identifier;
      const result = await limiter.limit(id);
      if (!result.success) {
        throw new RateLimitExceededError(id, result.limit, result.remaining, result.reset);
      }
    },
  };
}
