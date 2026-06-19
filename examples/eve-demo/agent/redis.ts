import { Redis } from "@upstash/redis";

/**
 * One shared Upstash Redis client for every AgentKit feature in this app
 * (long-term memory, the tool cache, and the model rate limiter).
 *
 * `Redis.fromEnv()` reads `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`.
 * Passing this single client to each helper keeps them on one connection
 * instead of each calling `Redis.fromEnv()` on its own.
 */
export const redis = Redis.fromEnv();
