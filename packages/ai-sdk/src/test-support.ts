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

/** Whether a real OpenAI key is available for end-to-end model tests. */
export const hasOpenAIKey = Boolean(process.env.OPENAI_API_KEY);

/** The model used by tests (always gpt-4o). */
export const TEST_MODEL = "gpt-4o";

/** A real Upstash Redis client from env. Only call when `hasRedisCreds` is true. */
export function testRedis(): Redis {
  return Redis.fromEnv();
}

/** A collision-proof key prefix so parallel test runs never share keys or indexes. */
export function uniquePrefix(label: string): string {
  return `test:${label}:${randomUUID().slice(0, 8)}`;
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
