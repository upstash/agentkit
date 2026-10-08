/**
 * The Upstash event backends: subscriptions in Redis, deliveries through QStash. Each delivery is
 * one QStash message to your endpoint, which signs every attempt fresh with the host's secret.
 */
import type { Redis } from "@upstash/redis";
import type { Client as QStashClient, Receiver } from "@upstash/qstash";
import {
  lazy,
  nonRetryable,
  readQStashJson,
  resolveQStash,
  resolveReceiver,
  resolveRedis,
} from "../../shared/clients.js";
import type {
  DeliveryJob,
  EventDelivery,
  SendJob,
  Subscription,
  SubscriptionStore,
} from "../types.js";

/** The most keys one `MGET` reads; `find` splits larger lookups. */
const MAX_BATCH = 1000;
/** Delivery retries after the first failed attempt. */
const DELIVERY_RETRIES = 3;

export type RedisSubscriptionStoreConfig = {
  /** The Upstash Redis client. Defaults to one from `UPSTASH_REDIS_REST_URL` / `_TOKEN`. */
  redis?: Redis;
  /** Key prefix. Defaults to `mcp-events:`. */
  prefix?: string;
  /** Set `false` to skip this package's tag in the telemetry header. */
  enableTelemetry?: boolean;
};

/**
 * One key per subscription, expiring with it, plus one sorted set per event scored by expiry. An
 * emit reads the event's live subscriptions, and the layer keeps those whose arguments match.
 */
export class RedisSubscriptionStore implements SubscriptionStore {
  private readonly prefix: string;
  private readonly redis: () => Redis;

  constructor(config: RedisSubscriptionStoreConfig = {}) {
    this.prefix = config.prefix ?? "mcp-events:";
    this.redis = lazy(() =>
      resolveRedis("RedisSubscriptionStore", config.redis, config.enableTelemetry),
    );
  }

  async put(subscription: Subscription): Promise<void> {
    const now = Date.now();
    const ttl = subscription.expiresAt - now;
    if (ttl <= 0) return;
    const index = this.indexKey(subscription.event);
    await this.redis()
      .multi()
      .set(this.subKey(subscription.id), JSON.stringify(subscription), { px: ttl })
      .zadd(index, { score: subscription.expiresAt, member: subscription.id })
      .zremrangebyscore(index, "-inf", now)
      .exec();
  }

  async get(id: string): Promise<Subscription | null> {
    return parse(await this.redis().get<unknown>(this.subKey(id)));
  }

  async delete({ id, event }: Pick<Subscription, "id" | "event">): Promise<void> {
    await this.redis().multi().del(this.subKey(id)).zrem(this.indexKey(event), id).exec();
  }

  async find(event: string): Promise<Subscription[]> {
    const ids = await this.redis().zrange<string[]>(this.indexKey(event), Date.now(), "+inf", {
      byScore: true,
    });
    const found: Subscription[] = [];
    for (let i = 0; i < ids.length; i += MAX_BATCH) {
      const keys = ids.slice(i, i + MAX_BATCH).map((id) => this.subKey(String(id)));
      for (const record of await this.redis().mget<unknown[]>(...keys)) {
        const sub = parse(record);
        if (sub) found.push(sub);
      }
    }
    return found;
  }

  private subKey(id: string): string {
    return `${this.prefix}sub:${id}`;
  }

  private indexKey(event: string): string {
    return `${this.prefix}idx:${event}`;
  }
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
  /** Set `false` to skip this package's tag in the telemetry header. */
  enableTelemetry?: boolean;
};

/** Every webhook delivery as a QStash message: durable, deduplicated, retried with backoff. */
export class QStashDelivery implements EventDelivery {
  private readonly config: QStashDeliveryConfig;
  private readonly qstash: () => QStashClient;
  private readonly receiver: () => Receiver;

  constructor(config: QStashDeliveryConfig) {
    this.config = config;
    this.qstash = lazy(() =>
      resolveQStash("QStashDelivery", config.qstash, config.enableTelemetry),
    );
    this.receiver = lazy(() => resolveReceiver("QStashDelivery", config.receiver));
  }

  async enqueue(jobs: DeliveryJob[]): Promise<void> {
    for (let i = 0; i < jobs.length; i += 100) {
      await this.qstash().batchJSON(
        jobs.slice(i, i + 100).map((job) => ({
          url: this.config.url,
          body: job,
          retries: DELIVERY_RETRIES,
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
  createDeliveryHandler(send: SendJob): (request: Request) => Promise<Response> {
    return async (request: Request): Promise<Response> => {
      // Outside any try: missing signing keys are a configuration error, not a bad signature.
      const job = await readQStashJson(request, this.receiver(), this.config.url);
      if (job instanceof Response) return job;
      if (!isDeliveryJob(job)) return nonRetryable("malformed body");
      return (await send(job))
        ? new Response("done")
        : new Response("callback failed", { status: 500 });
    };
  }
}

function isDeliveryJob(value: unknown): value is DeliveryJob {
  const job = value as Partial<DeliveryJob> | null;
  return typeof job?.subscriptionId === "string" && typeof job.envelope === "object";
}
