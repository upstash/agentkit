/**
 * The Upstash backends for events: subscriptions in Upstash Redis, deliveries through QStash.
 *
 * QStash is the part that makes the webhooks dependable. Each matching subscription becomes one
 * QStash message to your delivery endpoint, deduplicated per event and subscription and retried
 * with backoff when the host's callback fails. The endpoint signs every attempt fresh with the
 * host's secret, so a retry never carries a stale Standard Webhooks timestamp.
 */
import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";
import { Client as QStashClient, Receiver } from "@upstash/qstash";
import { addTelemetry } from "../../telemetry.js";
import type {
  DeliveryEndpoints,
  DeliveryJob,
  EventDelivery,
  Subscription,
  SubscriptionStore,
} from "../types.js";

export const DEFAULT_EVENTS_PREFIX = "mcp-events:";

export type RedisSubscriptionStoreConfig = {
  /** The Upstash Redis client. Defaults to one built from `UPSTASH_REDIS_REST_URL` / `_TOKEN`. */
  redis?: Redis;
  /** Key prefix. Defaults to `mcp-events:`. */
  prefix?: string;
  /** Set `false` to skip reporting the SDK version in the Redis telemetry header. */
  enableTelemetry?: boolean;
};

// Writes the record and its index entry together, with the record's own expiry, and keeps the
// index alive exactly as long as its longest-lived member.
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
 * One string key per subscription (expiring with it), plus a sorted set per `(event, argsKey)`
 * scored by expiry. An emit reads only the index entries it can match, so cost grows with the
 * number of matching subscriptions, not with the total.
 */
export class RedisSubscriptionStore implements SubscriptionStore {
  private readonly prefix: string;
  private readonly enableTelemetry: boolean;
  private readonly resolveRedis: () => Redis;
  private client: Redis | undefined;

  constructor(config: RedisSubscriptionStoreConfig | Redis = {}) {
    const options: RedisSubscriptionStoreConfig = isRedisClient(config)
      ? { redis: config }
      : config;
    this.prefix = options.prefix ?? DEFAULT_EVENTS_PREFIX;
    this.enableTelemetry = options.enableTelemetry ?? true;
    this.resolveRedis = () => options.redis ?? redisFromEnv();
  }

  private get redis(): Redis {
    if (!this.client) {
      this.client = this.resolveRedis();
      addTelemetry(this.client, { enabled: this.enableTelemetry });
    }
    return this.client;
  }

  async put(subscription: Subscription): Promise<void> {
    await this.redis.eval(
      PUT_SCRIPT,
      [this.subKey(subscription.id), this.indexKey(subscription.event, subscription.argsKey)],
      [
        JSON.stringify(subscription),
        String(subscription.expiresAt),
        subscription.id,
        String(Date.now()),
      ],
    );
  }

  async get(id: string): Promise<Subscription | null> {
    const subscription = parse(await this.redis.get<unknown>(this.subKey(id)));
    return subscription && subscription.expiresAt > Date.now() ? subscription : null;
  }

  async delete(id: string): Promise<void> {
    const subscription = parse(await this.redis.get<unknown>(this.subKey(id)));
    if (!subscription) return;
    const pipeline = this.redis.pipeline();
    pipeline.del(this.subKey(id));
    pipeline.zrem(this.indexKey(subscription.event, subscription.argsKey), id);
    await pipeline.exec();
  }

  async find(event: string, argsKeys: string[]): Promise<Subscription[]> {
    if (argsKeys.length === 0) return [];
    const now = Date.now();
    const pipeline = this.redis.pipeline();
    for (const argsKey of argsKeys) {
      pipeline.zrange(this.indexKey(event, argsKey), now, "+inf", { byScore: true });
    }
    const ids = [...new Set((await pipeline.exec<string[][]>()).flat().map(String))];
    if (ids.length === 0) return [];
    const records = await this.redis.mget<unknown[]>(...ids.map((id) => this.subKey(id)));
    return records
      .map(parse)
      .filter((sub): sub is Subscription => sub !== null && sub.expiresAt > now);
  }

  /** The key a subscription is stored under. */
  subKey(id: string): string {
    return `${this.prefix}sub:${id}`;
  }

  /** The index key for one `(event, argsKey)` pair. Hashed, because arguments can be long. */
  indexKey(event: string, argsKey: string): string {
    const digest = createHash("sha256").update(argsKey).digest("hex").slice(0, 24);
    return `${this.prefix}idx:${event}:${digest}`;
  }
}

function parse(raw: unknown): Subscription | null {
  if (raw === null || raw === undefined) return null;
  // @upstash/redis deserializes JSON values automatically unless told not to.
  const value = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  return value && typeof value === "object" ? (value as Subscription) : null;
}

export type QStashDeliveryConfig = {
  /** The public URL of your delivery endpoint, the route that serves `events.createDeliveryHandler()`. */
  url: string;
  /** The QStash client. Defaults to one built from `QSTASH_TOKEN` (and `QSTASH_URL`). */
  qstash?: QStashClient;
  /** Verifies QStash's signature on deliveries. Defaults to the `QSTASH_*_SIGNING_KEY` env vars. */
  receiver?: Receiver;
  /** Retries after the first failed attempt. Defaults to 3. */
  retries?: number;
  /** QStash retry delay expression, e.g. `"pow(2, retried) * 1000"`. Defaults to QStash's backoff. */
  retryDelay?: string;
  /** Extra headers QStash forwards to your endpoint. */
  headers?: Record<string, string>;
};

/** Every webhook delivery as a QStash message: durable, deduplicated, retried with backoff. */
export class QStashDelivery implements EventDelivery {
  private readonly url: string;
  private readonly config: QStashDeliveryConfig;
  private endpoints: DeliveryEndpoints | undefined;
  private client: QStashClient | undefined;
  private verifier: Receiver | undefined;

  constructor(config: QStashDeliveryConfig) {
    this.url = config.url;
    this.config = config;
  }

  attach(endpoints: DeliveryEndpoints): void {
    this.endpoints = endpoints;
  }

  private get qstash(): QStashClient {
    if (!this.client) this.client = this.config.qstash ?? qstashFromEnv();
    return this.client;
  }

  private get receiver(): Receiver {
    if (!this.verifier) this.verifier = this.config.receiver ?? receiverFromEnv();
    return this.verifier;
  }

  async enqueue(jobs: DeliveryJob[]): Promise<void> {
    for (let i = 0; i < jobs.length; i += 100) {
      await this.qstash.batchJSON(
        jobs.slice(i, i + 100).map((job) => ({
          url: this.url,
          body: job,
          retries: this.config.retries ?? 3,
          ...(this.config.retryDelay ? { retryDelay: this.config.retryDelay } : {}),
          ...(this.config.headers ? { headers: this.config.headers } : {}),
          // Emitting the same event id twice must not POST twice. QStash refuses ':' in the id.
          deduplicationId: `${job.envelope.eventId}_${job.subscriptionId}`.replace(/[^\w.-]/g, "-"),
        })),
      );
    }
  }

  /**
   * The delivery endpoint: `export const POST = events.createDeliveryHandler()`.
   *
   * - **200** — delivered, or retrying cannot help (the host answered 410 or 413, or the
   *   subscription is gone).
   * - **500** — the callback failed; QStash retries with backoff.
   * - **401** — QStash's signature did not verify.
   */
  createDeliveryHandler(): (request: Request) => Promise<Response> {
    return async (request: Request): Promise<Response> => {
      const endpoints = this.endpoints;
      if (!endpoints)
        throw new Error("QStashDelivery is not attached — pass it to createEventLayer().");
      const body = await request.text();
      try {
        await this.receiver.verify({
          signature: request.headers.get("upstash-signature") ?? "",
          body,
          url: this.url,
        });
      } catch {
        return new Response("invalid signature", { status: 401 });
      }
      let job: DeliveryJob;
      try {
        job = JSON.parse(body) as DeliveryJob;
      } catch {
        return new Response("malformed body", { status: 400 });
      }
      if (!job?.subscriptionId || !job.envelope)
        return new Response("malformed body", { status: 400 });
      const outcome = await endpoints.send(job);
      return outcome === "retry"
        ? new Response("callback failed", { status: 500 })
        : new Response(outcome);
    };
  }
}

function isRedisClient(value: RedisSubscriptionStoreConfig | Redis): value is Redis {
  return typeof (value as Redis).mget === "function";
}

function redisFromEnv(): Redis {
  const { UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: token } = process.env;
  if (!url || !token) {
    throw new Error(
      "RedisSubscriptionStore needs a client: pass `redis`, or set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
    );
  }
  return new Redis({ url, token });
}

function receiverFromEnv(): Receiver {
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!currentSigningKey || !nextSigningKey) {
    throw new Error(
      "createDeliveryHandler needs signing keys: pass `receiver`, or set QSTASH_CURRENT_SIGNING_KEY and QSTASH_NEXT_SIGNING_KEY.",
    );
  }
  return new Receiver({ currentSigningKey, nextSigningKey });
}

function qstashFromEnv(): QStashClient {
  const token = process.env.QSTASH_TOKEN;
  if (!token) throw new Error("QStashDelivery needs a client: pass `qstash`, or set QSTASH_TOKEN.");
  return new QStashClient({ token, baseUrl: process.env.QSTASH_URL });
}
