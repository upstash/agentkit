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
import { InlineTaskDispatcher } from "./tasks/backends/memory.js";
import type { Task, TaskDispatcher, TaskEndpoints, TaskError, TaskJournal } from "./tasks/types.js";

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
  return `test:mcp-toolkit:${label}:${randomUUID().slice(0, 8)}:`;
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

/** An inline dispatcher that counts what it was handed. */
export class CountingDispatcher extends InlineTaskDispatcher {
  dispatched = 0;
  override async dispatch(task: Task): Promise<string | undefined> {
    this.dispatched += 1;
    return await super.dispatch(task);
  }
}

/**
 * A dispatcher that records dispatches and runs nothing on its own, so a test drives each
 * delivery by hand, the way a queue would.
 */
export class ManualDispatcher<TContext = unknown> implements TaskDispatcher<TContext> {
  readonly dispatched: Task[] = [];
  readonly cancelled: string[] = [];
  /** Makes the next `dispatch` throw this error. */
  failNext: Error | undefined;
  private endpoints: TaskEndpoints<TContext> | undefined;

  attach(endpoints: TaskEndpoints<TContext>): void {
    this.endpoints = endpoints;
  }

  async dispatch(task: Task): Promise<string | undefined> {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }
    this.dispatched.push(task);
    return `msg_${this.dispatched.length}`;
  }

  async cancel(dispatchId: string): Promise<void> {
    this.cancelled.push(dispatchId);
  }

  /** Delivers a task, as the transport would. */
  run(taskId: string, context?: TContext, journal?: TaskJournal): Promise<unknown> {
    return this.attached().run(taskId, context as TContext, journal);
  }

  /** Reports that the transport gave up, as a failure callback would. */
  fail(taskId: string, error: TaskError): Promise<unknown> {
    return this.attached().fail(taskId, error);
  }

  private attached(): TaskEndpoints<TContext> {
    if (!this.endpoints) throw new Error("ManualDispatcher is not attached");
    return this.endpoints;
  }
}

/** The principal every test uses: the user id the verified auth carries, or a refusal. */
export function userIdOf({ auth }: { auth?: { extra?: Record<string, unknown> } }): string {
  const userId = auth?.extra?.userId;
  if (typeof userId !== "string") throw new Error("Not authenticated");
  return userId;
}
