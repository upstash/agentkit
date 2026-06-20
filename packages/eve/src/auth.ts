import { createRateLimit, type RateLimitConfig } from "@upstash/agentkit-sdk";
import { Redis } from "@upstash/redis";
import { ForbiddenError, type AuthFn } from "eve/channels/auth";

/** Configuration for {@link createRateLimitAuth}. */
export interface RateLimitAuthConfig extends Omit<RateLimitConfig, "redis"> {
  /** Upstash Redis client backing the limiter. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /**
   * The rate-limit identifier (e.g. a user/tenant id, an API key, an IP), or a function deriving one
   * from the inbound `Request`. Defaults to `"global"` (one shared bucket for every caller).
   */
  identifier?: string | ((request: Request) => string | Promise<string>);
  /** Message returned in the 403 body when the caller is over the limit. */
  message?: string;
}

/**
 * Build an eve route-auth `AuthFn` that rate-limits inbound requests. Drop it into your channel's
 * `auth` walk ahead of your real authenticators: it throttles the request and, when under the limit,
 * returns `null` so the walk falls through to the next entry (it is a gate, not an identity provider).
 * Over the limit it throws a `ForbiddenError` (HTTP 403). Backed by {@link createRateLimit}; keys are
 * `agentkit:rateLimit:<identifier>`.
 *
 * ```ts
 * // agent/channels/eve.ts
 * import { createRateLimitAuth } from "@upstash/agentkit-eve";
 * import { localDev, vercelOidc } from "eve/channels/auth";
 * import { eveChannel } from "eve/channels/eve";
 *
 * export default eveChannel({
 *   auth: [createRateLimitAuth({ limit: 20, window: "1 m" }), localDev(), vercelOidc()],
 * });
 * ```
 */
export function createRateLimitAuth(config: RateLimitAuthConfig = {}): AuthFn<Request> {
  const { identifier, message, redis, ...rest } = config;
  const ratelimit = createRateLimit({ ...rest, redis: redis ?? Redis.fromEnv() });

  return async (request) => {
    const id =
      typeof identifier === "function" ? await identifier(request) : (identifier ?? "global");
    const { success } = await ratelimit.limit(id);
    if (!success) {
      throw new ForbiddenError({ message: message ?? "Rate limit exceeded. Try again shortly." });
    }
    return null; // under the limit — fall through to the next auth entry
  };
}
