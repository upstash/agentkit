import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import { Ratelimit, type Duration } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

type WrapArgs = Parameters<typeof wrapLanguageModel>[0];
type LanguageModel = WrapArgs["model"];

/** Thrown when a model call is blocked by the rate limiter (and `onLimit` is `"throw"`). */
export class RateLimitExceededError extends Error {
  readonly reset: number;
  readonly limit: number;
  constructor(identifier: string, limit: number, reset: number) {
    super(`Rate limit exceeded for "${identifier}" (${limit} per window). Resets at ${reset}.`);
    this.name = "RateLimitExceededError";
    this.limit = limit;
    this.reset = reset;
  }
}

export interface RateLimitMiddlewareConfig {
  /** A pre-built {@link Ratelimit}. Built from `redis` + `limit`/`window` when omitted. */
  ratelimit?: Ratelimit;
  /** Upstash Redis client used to build a limiter. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /** Requests allowed per `window` when building a sliding-window limiter. Defaults to 10. */
  limit?: number;
  /** Sliding window duration (e.g. `"10 s"`, `"1 m"`). Defaults to `"60 s"`. */
  window?: Duration;
  /** Namespace (key prefix) for the limiter. Defaults to `agentkit:ratelimit`. */
  namespace?: string;
  /**
   * The rate-limit identifier (e.g. a user id), or a function returning one. Defaults to `"global"`.
   * Build the model per-request with a per-user identifier to rate-limit by user.
   */
  identifier?: string | (() => string | Promise<string>);
  /**
   * On exceeding the limit: `"throw"` a {@link RateLimitExceededError} (default), or `"wait"` until a
   * token is available (up to `waitTimeoutMs`).
   */
  onLimit?: "throw" | "wait";
  /** Max time to wait when `onLimit` is `"wait"`. Defaults to 10000ms. */
  waitTimeoutMs?: number;
}

function resolveRatelimit(config: RateLimitMiddlewareConfig): Ratelimit {
  if (config.ratelimit) return config.ratelimit;
  return new Ratelimit({
    redis: config.redis ?? Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(config.limit ?? 10, config.window ?? "60 s"),
    prefix: config.namespace ?? "agentkit:ratelimit",
  });
}

/**
 * An AI SDK language-model middleware that enforces an [Upstash Ratelimit](https://github.com/upstash/ratelimit-js)
 * before each model call. On exceeding the limit it throws (default) or waits for a free token.
 *
 * ```ts
 * import { wrapLanguageModel } from "ai";
 * const model = wrapLanguageModel({
 *   model: base,
 *   middleware: rateLimitMiddleware({ redis, limit: 20, window: "1 m", identifier: userId }),
 * });
 * ```
 */
export function rateLimitMiddleware(
  config: RateLimitMiddlewareConfig = {},
): LanguageModelMiddleware {
  const ratelimit = resolveRatelimit(config);
  const onLimit = config.onLimit ?? "throw";
  const waitTimeoutMs = config.waitTimeoutMs ?? 10_000;

  const enforce = async (): Promise<void> => {
    const identifier =
      typeof config.identifier === "function"
        ? await config.identifier()
        : (config.identifier ?? "global");
    const result = await ratelimit.limit(identifier);
    if (result.success) return;
    if (onLimit === "wait") {
      const ready = await ratelimit.blockUntilReady(identifier, waitTimeoutMs);
      if (ready.success) return;
    }
    throw new RateLimitExceededError(identifier, result.limit, result.reset);
  };

  return {
    wrapGenerate: async ({ doGenerate }) => {
      await enforce();
      return doGenerate();
    },
    wrapStream: async ({ doStream }) => {
      await enforce();
      return doStream();
    },
  };
}

export interface RateLimitedModelConfig extends RateLimitMiddlewareConfig {
  /** The language model to wrap. */
  model: LanguageModel;
}

/**
 * Wrap a language model so every call is rate-limited via Upstash Ratelimit.
 *
 * ```ts
 * const model = rateLimitedModel({ model: openai("gpt-4o"), redis, limit: 20, window: "1 m" });
 * ```
 */
export function rateLimitedModel(config: RateLimitedModelConfig): LanguageModel {
  const { model, ...rest } = config;
  return wrapLanguageModel({ model, middleware: rateLimitMiddleware(rest) });
}
