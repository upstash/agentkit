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
  /** The limiter algorithm, e.g. `Ratelimit.slidingWindow(10, "60 s")` or `Ratelimit.fixedWindow(...)`. */
  limiter: Limiter;
  /** Key prefix for the limiter. Defaults to `agentkit:rateLimit`; keys are `<prefix>:<identifier>`. */
  prefix?: string;
}

/**
 * Build a configured [Upstash Ratelimit](https://github.com/upstash/ratelimit-js) `Ratelimit` with
 * AgentKit defaults. The returned value is a plain `Ratelimit`, so call `.limit(identifier)` yourself
 * before doing work (e.g. before `generateText`). Keys are `agentkit:rateLimit:<identifier>`.
 *
 * ```ts
 * const ratelimit = createRateLimit({ redis, limiter: Ratelimit.slidingWindow(30, "1 m") });
 * const { success } = await ratelimit.limit("user-123");
 * if (!success) throw new Error("rate limited");
 * ```
 */
export function createRateLimit(config: RateLimitConfig): Ratelimit {
  return new Ratelimit({
    redis: config.redis,
    limiter: config.limiter,
    prefix: config.prefix ?? "agentkit:rateLimit",
  });
}
