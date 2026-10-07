import type { Redis } from "@upstash/redis";
import { Redis as RedisClient } from "@upstash/redis";
import { ToolCache, createRateLimit } from "@upstash/agentkit-sdk";
import type { RateLimitConfig, ToolCacheConfig } from "@upstash/agentkit-sdk";
import type { ChatMiddleware, ChatMiddlewareContext } from "@tanstack/ai";
import { addTelemetry } from "../telemetry.js";

/**
 * The core {@link ToolCacheConfig} (`prefix`, `ttlSeconds`), with `redis` optional, plus which tools
 * to cache and who the entries belong to.
 */
export type ToolCacheMiddlewareConfig = Omit<ToolCacheConfig, "redis"> & {
  /**
   * Names of the tools whose results may be cached. Required on purpose: only deterministic,
   * side-effect-free tools belong here (a cached `send_email` would silently stop sending).
   */
  tools: string[];
  /** The user entries are scoped to — a string, or derived from the run context. */
  userId: string | ((ctx: ChatMiddlewareContext) => string);
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
};

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
  const { tools, userId, ...cacheConfig } = config;
  const cache = new ToolCache({ ...cacheConfig, redis });
  const allowed = new Set(tools);
  const resolveUserId = (ctx: ChatMiddlewareContext) =>
    typeof userId === "function" ? userId(ctx) : userId;
  // Calls this middleware has seen: the args to key the write with, or "hit" when served. Keyed by
  // request + call id, because one middleware instance can serve concurrent `chat()` calls and
  // providers only guarantee call ids are unique within a request.
  const pending = new Map<string, { args: unknown } | "hit">();
  const callKey = (ctx: ChatMiddlewareContext, toolCallId: string) =>
    `${ctx.requestId}:${toolCallId}`;

  return {
    name: "upstash-tool-cache",
    async onBeforeToolCall(ctx, hook) {
      if (!allowed.has(hook.toolName)) return;
      const hit = await cache.get(resolveUserId(ctx), hook.toolName, hook.args);
      if (hit) {
        pending.set(callKey(ctx, hook.toolCallId), "hit");
        return { type: "skip", result: hit.value };
      }
      pending.set(callKey(ctx, hook.toolCallId), { args: hook.args });
      return;
    },
    async onAfterToolCall(ctx, info) {
      const seen = pending.get(callKey(ctx, info.toolCallId));
      pending.delete(callKey(ctx, info.toolCallId));
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
  // Resolve the client here so the default one is tagged too, not only a client passed in.
  const redis = config.redis ?? RedisClient.fromEnv();
  addTelemetry(redis, config.enableTelemetry);
  const limiter = createRateLimit({ ...limitConfig, redis });
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
