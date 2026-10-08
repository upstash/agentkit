/**
 * The Upstash event backends: subscriptions in Redis, deliveries through QStash. Each delivery is
 * one QStash message to your endpoint, which signs every attempt fresh with the host's secret.
 */
import type { Redis } from "@upstash/redis";
import type { Client as QStashClient, Receiver } from "@upstash/qstash";
import {
  lazy,
  nonRetryable,
  resolveQStash,
  resolveReceiver,
  resolveRedis,
} from "../../shared/clients.js";
import { sha256Hex } from "../../shared/crypto.js";
import type {
  DeliveryEndpoints,
  DeliveryJob,
  EventDelivery,
  Subscription,
  SubscriptionRef,
  SubscriptionStore,
} from "../types.js";

export const DEFAULT_EVENTS_PREFIX = "mcp-events:";

/** The most commands one pipeline or `MGET` carries; `find` splits larger lookups. */
const MAX_BATCH = 1000;

export type RedisSubscriptionStoreConfig = {
  /** The Upstash Redis client. Defaults to one from `UPSTASH_REDIS_REST_URL` / `_TOKEN`. */
  redis?: Redis;
  /** Key prefix. Defaults to `mcp-events:`. */
  prefix?: string;
  /** Set `false` to skip this package's tag in the telemetry header. */
  enableTelemetry?: boolean;
};

/**
 * Writes the record with its expiry and its index entry, and keeps the index alive as long as its
 * longest-lived member. ARGV: record, expiresAt, id, now.
 */
const PUT_SCRIPT = `#!lua flags=allow-key-locking
local ttl = tonumber(ARGV[2]) - tonumber(ARGV[4])
if ttl <= 0 then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ttl)
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[4])
if redis.call('PTTL', KEYS[2]) < ttl then redis.call('PEXPIRE', KEYS[2], ttl) end
return 1
`;

/**
 * One key per subscription, expiring with it, plus a sorted set per `(event, argsKey)` scored by
 * expiry. An emit reads only the index entries it can match.
 */
export class RedisSubscriptionStore implements SubscriptionStore {
  private readonly prefix: string;
  private readonly redis: () => Redis;

  constructor(config: RedisSubscriptionStoreConfig = {}) {
    this.prefix = config.prefix ?? DEFAULT_EVENTS_PREFIX;
    this.redis = lazy(() =>
      resolveRedis("RedisSubscriptionStore", config.redis, config.enableTelemetry),
    );
  }

  async put(subscription: Subscription): Promise<void> {
    await this.redis().eval(
      PUT_SCRIPT,
      [this.subKey(subscription.id), await this.indexKey(subscription)],
      [
        JSON.stringify(subscription),
        String(subscription.expiresAt),
        subscription.id,
        String(Date.now()),
      ],
    );
  }

  async get(id: string): Promise<Subscription | null> {
    return parse(await this.redis().get<unknown>(this.subKey(id)));
  }

  async delete(subscription: SubscriptionRef): Promise<void> {
    const pipeline = this.redis().pipeline();
    pipeline.del(this.subKey(subscription.id));
    pipeline.zrem(await this.indexKey(subscription), subscription.id);
    await pipeline.exec();
  }

  async find(event: string, argsKeys: readonly string[]): Promise<Subscription[]> {
    if (argsKeys.length === 0) return [];
    const keys = await Promise.all(argsKeys.map((argsKey) => this.indexKey({ event, argsKey })));
    const now = Date.now();
    const ids = new Set<string>();
    for (const batch of chunks(keys, MAX_BATCH)) {
      const pipeline = this.redis().pipeline();
      for (const key of batch) pipeline.zrange(key, now, "+inf", { byScore: true });
      for (const id of (await pipeline.exec<string[][]>()).flat()) ids.add(String(id));
    }
    // A popular event can match many subscriptions, so the reads are batched too.
    const found: Subscription[] = [];
    for (const batch of chunks([...ids], MAX_BATCH)) {
      const records = await this.redis().mget<unknown[]>(...batch.map((id) => this.subKey(id)));
      for (const record of records) {
        const sub = parse(record);
        if (sub) found.push(sub);
      }
    }
    return found;
  }

  /** The key a subscription is stored under. */
  subKey(id: string): string {
    return `${this.prefix}sub:${id}`;
  }

  /** The index key for one `(event, argsKey)`. Hashed, because arguments can be long. */
  async indexKey({ event, argsKey }: Pick<Subscription, "event" | "argsKey">): Promise<string> {
    return `${this.prefix}idx:${event}:${(await sha256Hex(argsKey)).slice(0, 24)}`;
  }
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function parse(raw: unknown): Subscription | null {
  if (raw === null || raw === undefined) return null;
  // @upstash/redis deserializes JSON values automatically unless told not to.
  const value = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  return value && typeof value === "object" ? (value as Subscription) : null;
}

export type QStashDeliveryConfig = {
  /** The public URL of the route serving `events.createDeliveryHandler()`. */
  url: string;
  /** The QStash client. Defaults to one from `QSTASH_TOKEN` (and `QSTASH_URL`). */
  qstash?: QStashClient;
  /**
   * Verifies deliveries. Defaults to one from the `QSTASH_*_SIGNING_KEY` env vars. Required either
   * way: without keys the endpoint refuses to serve.
   */
  receiver?: Receiver;
  /** Retries after the first failed attempt. Defaults to 3. */
  retries?: number;
  /** QStash retry delay expression. Defaults to QStash's backoff. */
  retryDelay?: string;
  /** Extra headers QStash forwards to your endpoint. */
  headers?: Record<string, string>;
  /** Set `false` to skip this package's tag in the telemetry header. */
  enableTelemetry?: boolean;
};

/** Every webhook delivery as a QStash message: durable, deduplicated, retried with backoff. */
export class QStashDelivery implements EventDelivery {
  private readonly config: QStashDeliveryConfig;
  private readonly qstash: () => QStashClient;
  private readonly receiver: () => Receiver;
  private endpoints: DeliveryEndpoints | undefined;

  constructor(config: QStashDeliveryConfig) {
    this.config = config;
    this.qstash = lazy(() =>
      resolveQStash("QStashDelivery", config.qstash, config.enableTelemetry),
    );
    this.receiver = lazy(() => resolveReceiver("QStashDelivery", config.receiver));
  }

  attach(endpoints: DeliveryEndpoints): void {
    this.endpoints = endpoints;
  }

  async enqueue(jobs: DeliveryJob[]): Promise<void> {
    for (let i = 0; i < jobs.length; i += 100) {
      await this.qstash().batchJSON(
        jobs.slice(i, i + 100).map((job) => ({
          url: this.config.url,
          body: job,
          retries: this.config.retries ?? 3,
          ...(this.config.retryDelay ? { retryDelay: this.config.retryDelay } : {}),
          ...(this.config.headers ? { headers: this.config.headers } : {}),
          // Emitting the same event id twice must not POST twice. QStash refuses ':' in ids.
          deduplicationId: `${job.envelope.eventId}_${job.subscriptionId}`.replace(/[^\w.-]/g, "-"),
        })),
      );
    }
  }

  /**
   * The delivery endpoint.
   *
   * - **200**: delivered, or retrying cannot help (410, 413, redirect, subscription gone).
   * - **500**: the callback failed; QStash retries.
   * - **489** with `Upstash-NonRetryable-Error`: bad signature or body, never retried.
   */
  createDeliveryHandler(): (request: Request) => Promise<Response> {
    return async (request: Request): Promise<Response> => {
      const endpoints = this.endpoints;
      if (!endpoints) {
        throw new Error("QStashDelivery is not attached — pass it to createEventLayer().");
      }
      // Outside the try: missing signing keys are a configuration error, not a bad signature.
      const receiver = this.receiver();
      const body = await request.text();
      try {
        await receiver.verify({
          signature: request.headers.get("upstash-signature") ?? "",
          body,
          url: this.config.url,
        });
      } catch {
        return nonRetryable("invalid signature");
      }
      let job: DeliveryJob;
      try {
        job = JSON.parse(body) as DeliveryJob;
      } catch {
        return nonRetryable("malformed body");
      }
      if (!job?.subscriptionId || !job.envelope) return nonRetryable("malformed body");
      const outcome = await endpoints.send(job);
      return outcome === "retry"
        ? new Response("callback failed", { status: 500 })
        : new Response(outcome);
    };
  }
}
