/**
 * Test-only helpers (never imported by `index.ts`). The integration suite runs against a real
 * Upstash Redis; credentials come from the repo-root `.env`, and without them `hasRedisCreds` is
 * false and the suite skips itself.
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

/** A collision-proof key prefix so parallel test runs never share keys or channels. */
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

/** A source stream the test writes to, standing in for an LLM response. */
export function controlledSource(): {
  readable: ReadableStream<string>;
  write: (chunk: string) => void;
  close: () => void;
} {
  let write!: (chunk: string) => void;
  let close!: () => void;
  const readable = new ReadableStream<string>({
    start: (controller) => {
      write = (chunk) => controller.enqueue(chunk);
      close = () => controller.close();
    },
  });
  return { readable, write, close };
}

/** Reads a stream to the end and joins its chunks. */
export async function readAll(stream: ReadableStream<string>): Promise<string> {
  let text = "";
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += value;
  }
}

/** Polls `check` until it returns true or `timeoutMs` passes. */
export async function pollUntil(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
