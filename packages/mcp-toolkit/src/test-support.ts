/**
 * Test-only helpers, test dispatchers and in-memory event backends (never imported by an entry
 * point).
 *
 * Per the project's testing policy the Redis backends are exercised against a real Upstash Redis
 * rather than a mock. Credentials come from the repo-root `.env`; without them `hasRedisCreds` is
 * false and those suites skip themselves so CI without secrets stays green.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { config } from "dotenv";
import { Receiver } from "@upstash/qstash";
import { Redis } from "@upstash/redis";
import type {
  DeliveryJob,
  EventDelivery,
  SendJob,
  Subscription,
  SubscriptionStore,
} from "./events/types.js";
import { InProcessDispatcher } from "./tasks/memory.js";
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

/** The principal every test uses: the user id the verified auth carries, or a refusal. */
export function userIdOf({ auth }: { auth?: { extra?: Record<string, unknown> } }): string {
  const userId = auth?.extra?.userId;
  if (typeof userId !== "string") throw new Error("Not authenticated");
  return userId;
}

/** A valid events `secretKey`: base64 of 32 bytes. */
export const TEST_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");

// ---------------------------------------------------------------------------------------------
// QStash signatures

/** The signing key {@link testReceiver} accepts. */
export const TEST_SIGNING_KEY = "sig_test_current";

/** A real QStash `Receiver`, with keys only the tests know. */
export function testReceiver(): Receiver {
  return new Receiver({ currentSigningKey: TEST_SIGNING_KEY, nextSigningKey: "sig_test_next" });
}

/**
 * The `Upstash-Signature` QStash would send: an HS256 JWT over the body hash, issued for `url`.
 * Override any claim to forge a bad one.
 */
export function signQStash(
  body: string,
  url: string,
  overrides: { key?: string; sub?: string; body?: string; exp?: number } = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: "Upstash",
      sub: overrides.sub ?? url,
      exp: overrides.exp ?? now + 300,
      nbf: now - 1,
      iat: now,
      jti: randomUUID(),
      body: overrides.body ?? createHash("sha256").update(body).digest("base64url"),
    }),
  );
  const signature = createHmac("sha256", overrides.key ?? TEST_SIGNING_KEY)
    .update(`${header}.${claims}`)
    .digest("base64url");
  return `${header}.${claims}.${signature}`;
}

/** A POST QStash would make to `url`, signed for `signedFor` (defaults to `url`). */
export function qstashRequest(
  url: string,
  body: unknown,
  signature?: Parameters<typeof signQStash>[2],
): Request {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "upstash-signature": signQStash(text, url, signature),
    },
    body: text,
  });
}

// ---------------------------------------------------------------------------------------------
// Task dispatchers for tests (the shipped in-memory backends are in `tasks/memory.ts`)

/**
 * A dispatcher that records dispatches and runs nothing on its own, so a test drives each
 * delivery by hand, the way a queue would. The layer connects it when it is created.
 */
export class ManualDispatcher<TContext = unknown> implements TaskDispatcher<TContext> {
  readonly dispatched: Task[] = [];
  readonly cancelled: string[] = [];
  /** Makes the next `dispatch` throw this error. */
  failNext: Error | undefined;
  private endpoints: TaskEndpoints<TContext> | undefined;

  async dispatch(task: Task): Promise<void> {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }
    this.dispatched.push(task);
  }

  async cancel(taskId: string): Promise<void> {
    this.cancelled.push(taskId);
  }

  connect(endpoints: TaskEndpoints<TContext>): void {
    this.endpoints = endpoints;
  }

  createExecuteHandler(endpoints: TaskEndpoints<TContext>): () => Promise<Response> {
    this.connect(endpoints);
    return async () => new Response("manual dispatcher: drive deliveries with run()");
  }

  /** Delivers a task, as the transport would. */
  run(taskId: string, context?: TContext, journal?: TaskJournal): Promise<void> {
    return this.connected().run(taskId, context as TContext, journal);
  }

  /** Reports that the transport gave up, as a failure callback would. */
  fail(taskId: string, error: TaskError): Promise<void> {
    return this.connected().fail(taskId, error);
  }

  private connected(): TaskEndpoints<TContext> {
    if (!this.endpoints) throw new Error("Pass the dispatcher to createTaskLayer first");
    return this.endpoints;
  }
}

/** The shipped {@link InProcessDispatcher}, also recording what it was asked to dispatch. */
export class InlineDispatcher extends InProcessDispatcher {
  readonly dispatched: Task[] = [];

  override async dispatch(task: Task): Promise<void> {
    this.dispatched.push(task);
    await super.dispatch(task);
  }
}

// ---------------------------------------------------------------------------------------------
// In-memory event backends

/** An in-process {@link SubscriptionStore}. Not durable, not shared between instances. */
export class MemorySubscriptionStore implements SubscriptionStore {
  readonly subscriptions = new Map<string, Subscription>();

  async put(subscription: Subscription, options: { limit: number }): Promise<boolean> {
    const replacing = this.subscriptions.has(subscription.id);
    if (!replacing && (await this.count(subscription.subscriber)) >= options.limit) return false;
    this.subscriptions.set(subscription.id, { ...subscription });
    return true;
  }

  async count(subscriber: string): Promise<number> {
    return [...this.subscriptions.values()].filter(
      (sub) => sub.subscriber === subscriber && sub.expiresAt > Date.now(),
    ).length;
  }

  async get(id: string): Promise<Subscription | null> {
    const subscription = this.subscriptions.get(id);
    return subscription && subscription.expiresAt > Date.now() ? { ...subscription } : null;
  }

  async delete({ id }: Pick<Subscription, "id">): Promise<void> {
    this.subscriptions.delete(id);
  }

  async find(event: string): Promise<Subscription[]> {
    return [...this.subscriptions.values()]
      .filter((sub) => sub.event === event && sub.expiresAt > Date.now())
      .map((sub) => ({ ...sub }));
  }
}

/**
 * Sends each delivery from the calling process, once, and records whether it finished. It is
 * connected when the layer's `createDeliveryHandler()` is called.
 */
export class InlineDelivery implements EventDelivery {
  readonly outcomes: { job: DeliveryJob; done: boolean }[] = [];
  private send: SendJob | undefined;

  async enqueue(jobs: DeliveryJob[]): Promise<void> {
    const send = this.send;
    if (!send) throw new Error("Call events.createDeliveryHandler() first");
    for (const job of jobs) this.outcomes.push({ job, done: await send(job) });
  }

  createDeliveryHandler(send: SendJob): () => Promise<Response> {
    this.send = send;
    return async () => new Response("inline delivery: jobs are sent on enqueue");
  }
}
