import { Ratelimit, type Duration } from "@upstash/ratelimit";
import type { Redis } from "@upstash/redis";

// Re-export the `@upstash/ratelimit` surface AgentKit users need so they never have to import from
// (or install) `@upstash/ratelimit` directly. `Ratelimit` is the class whose static helpers build a
// custom `limiter` (e.g. `Ratelimit.fixedWindow(...)`); `Duration` types the `window` option.
export { Ratelimit };
export type { Duration };

/** Limiter algorithm accepted by `@upstash/ratelimit` (the value `Ratelimit.slidingWindow(...)` etc. returns). */
type Limiter = ConstructorParameters<typeof Ratelimit>[0]["limiter"];

/** Configuration for {@link createRateLimit}. */
export interface RateLimitConfig {
  /** Upstash Redis client used to back the limiter. */
  redis: Redis;
  /** Requests allowed per `window` for the default sliding-window limiter. Defaults to 10. */
  limit?: number;
  /** Sliding-window duration for the default limiter (e.g. `"10 s"`, `"1 m"`). Defaults to `"60 s"`. */
  window?: Duration;
  /** Key prefix for the limiter. Defaults to `agentkit:rateLimit`; keys are `<prefix>:<identifier>`. */
  prefix?: string;
  /** A fully custom limiter (e.g. `Ratelimit.fixedWindow(...)`) overriding the `limit`/`window` default. */
  limiter?: Limiter;
}

/**
 * Build a configured [Upstash Ratelimit](https://github.com/upstash/ratelimit-js) `Ratelimit` with
 * AgentKit defaults. The returned value is a plain `Ratelimit`, so call `.limit(identifier)` yourself
 * before doing work (e.g. before `generateText`). Keys are `agentkit:rateLimit:<identifier>`.
 *
 * ```ts
 * const ratelimit = createRateLimit({ redis, limit: 30, window: "1 m" });
 * const { success } = await ratelimit.limit("user-123");
 * if (!success) throw new Error("rate limited");
 * ```
 */
export function createRateLimit(config: RateLimitConfig): Ratelimit {
  return new Ratelimit({
    redis: config.redis,
    limiter: config.limiter ?? Ratelimit.slidingWindow(config.limit ?? 10, config.window ?? "60 s"),
    prefix: config.prefix ?? "agentkit:rateLimit",
  });
}
