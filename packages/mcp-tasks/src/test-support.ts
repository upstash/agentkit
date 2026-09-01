/**
 * Test-only helpers (never imported by `index.ts`).
 *
 * Per the project's testing policy the store is exercised against a real Upstash Redis rather
 * than a mock. Credentials come from the repo-root `.env`; without them `hasRedisCreds` is false
 * and those suites skip themselves so CI without secrets stays green.
 */
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { Redis } from "@upstash/redis";

// Load repo-root .env (no-op if already loaded or absent).
config();

export const hasRedisCreds = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
);

/** A real Upstash Redis client from env. Only call when `hasRedisCreds` is true. */
export function testRedis(): Redis {
  return Redis.fromEnv();
}

/** A collision-proof key prefix so parallel runs never share keys. */
export function uniquePrefix(label: string): string {
  return `test:mcp-tasks:${label}:${randomUUID().slice(0, 8)}:`;
}

/** Delete every key under a key prefix (best-effort cleanup in afterAll hooks). */
export async function cleanupKeys(redis: Redis, prefix: string): Promise<void> {
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, { match: `${prefix}*`, count: 200 });
    cursor = next;
    if (keys.length) await redis.del(...keys);
  } while (cursor !== "0");
}

/** Resolves after `ms`. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
