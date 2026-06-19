/**
 * Test-only helpers (never imported by `index.ts`). The adapter tests run against a real Upstash
 * Redis instance — only LLM calls are mocked. Credentials come from the repo-root `.env`; when
 * absent, `hasRedisCreds` is false and the suites skip themselves.
 */
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { Redis } from "@upstash/redis";

config();

export const hasRedisCreds = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
);

/** A real Upstash Redis client from env. Only call when `hasRedisCreds` is true. */
export function testRedis(): Redis {
  return Redis.fromEnv();
}

/** A collision-proof namespace so parallel test runs never share keys or indexes. */
export function uniqueNamespace(label: string): string {
  return `test:${label}:${randomUUID().slice(0, 8)}`;
}

/** Delete every key under a namespace (best-effort cleanup in afterAll hooks). */
export async function cleanupKeys(redis: Redis, namespace: string): Promise<void> {
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, { match: `${namespace}*`, count: 200 });
    cursor = next;
    if (keys.length) await redis.del(...keys);
  } while (cursor !== "0");
}
