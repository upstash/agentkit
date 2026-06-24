import { createRateLimit, type RateLimitConfig } from "@upstash/agentkit-sdk";
import { Redis } from "@upstash/redis";
import { ForbiddenError, type AuthFn } from "eve/channels/auth";

/** Configuration for {@link createRateLimitAuth}. */
export interface RateLimitAuthConfig extends Omit<RateLimitConfig, "redis"> {
  /** Upstash Redis client backing the limiter. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /**
   * The rate-limit identifier — **required**. A static string (e.g. a tenant id) shares one bucket, so
   * for per-user limiting pass a function deriving the id from the inbound `Request` (an authenticated
   * user id, an API key, or `x-forwarded-for` for per-IP). There is intentionally **no** default: a
   * single global bucket means one abusive caller can exhaust the window for everyone.
   */
  identifier: string | ((request: Request) => string | Promise<string>);
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
 * **Only `POST` requests are counted** (the message-submitting routes that actually invoke the model:
 * `POST /eve/v1/session` and `POST /eve/v1/session/:id`). eve drives each turn as two authenticated
 * requests — the message `POST` **and** a follow-up `GET …/stream` that opens the reply stream — and
 * the auth walk runs on both. Counting both would charge every turn twice; gating only the `POST`
 * makes one turn cost exactly one token, while the session-read `GET`s fall through unthrottled.
 *
 * ```ts
 * // agent/channels/eve.ts
 * import { createRateLimitAuth, Ratelimit } from "@upstash/agentkit-eve";
 * import { localDev, vercelOidc } from "eve/channels/auth";
 * import { eveChannel } from "eve/channels/eve";
 *
 * export default eveChannel({
 *   auth: [
 *     createRateLimitAuth({
 *       limiter: Ratelimit.slidingWindow(20, "1 m"),
 *       identifier: (req) => req.headers.get("x-forwarded-for") ?? "anonymous", // required
 *     }),
 *     localDev(),
 *     vercelOidc(),
 *   ],
 * });
 * ```
 */
export function createRateLimitAuth(config: RateLimitAuthConfig): AuthFn<Request> {
  const { identifier, message, redis, ...rest } = config;
  const ratelimit = createRateLimit({ ...rest, redis: redis ?? Redis.fromEnv() });

  return async (request) => {
    // Only throttle the model-invoking message submissions (POST). The follow-up `GET …/stream` (and
    // other session reads) share this auth walk but shouldn't each cost a token — let them through so
    // a single turn = a single increment.
    if (request.method !== "POST") return null;
    const id = typeof identifier === "function" ? await identifier(request) : identifier;
    const { success } = await ratelimit.limit(id);
    if (!success) {
      throw new ForbiddenError({ message: message ?? "Rate limit exceeded. Try again shortly." });
    }
    return null; // under the limit — fall through to the next auth entry
  };
}
