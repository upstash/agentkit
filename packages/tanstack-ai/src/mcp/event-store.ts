import type { Redis } from "@upstash/redis";
import { Redis as RedisClient } from "@upstash/redis";
import type { MCPEventStore, MCPEventSubscription } from "@tanstack/ai-mcp/events";
import { addTelemetry } from "../telemetry.js";
import { KEY_LOCKING } from "../persistence/records.js";

export interface UpstashMcpEventStoreConfig {
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /** Base key prefix. Defaults to `agentkit:tanstack`. */
  prefix?: string;
  /** Set `false` to opt out of the telemetry header. */
  enableTelemetry?: boolean;
}

// Index values and set members are "~" + key, so the client never JSON-parses a numeric-looking key.

/**
 * Write a subscription and keep the id index in step.
 * KEYS: document hash (fields d, r, i), id→key hash, key set, revision counter.
 * ARGV: key, document JSON, expected revision ("" = unconditional), id ("" = none).
 * Returns the new revision, or -1 if the revision moved. Revisions come from one counter, so a
 * delete and re-create never brings an old revision back.
 */
const WRITE = `${KEY_LOCKING}if ARGV[3] ~= "" and tostring(redis.call("HGET", KEYS[1], "r")) ~= ARGV[3] then return -1 end
local prev = redis.call("HGET", KEYS[1], "i")
if prev and prev ~= ARGV[4] then redis.call("HDEL", KEYS[2], prev) end
local rev = redis.call("INCR", KEYS[4])
redis.call("HSET", KEYS[1], "d", ARGV[2], "r", rev)
if ARGV[4] ~= "" then
  redis.call("HSET", KEYS[1], "i", ARGV[4])
  redis.call("HSET", KEYS[2], ARGV[4], "~" .. ARGV[1])
else
  redis.call("HDEL", KEYS[1], "i")
end
redis.call("SADD", KEYS[3], "~" .. ARGV[1])
return rev`;

/** KEYS: document hash, id→key hash, key set. ARGV: key. */
const DELETE = `${KEY_LOCKING}local prev = redis.call("HGET", KEYS[1], "i")
if prev then redis.call("HDEL", KEYS[2], prev) end
redis.call("DEL", KEYS[1])
redis.call("SREM", KEYS[3], "~" .. ARGV[1])
return 1`;

interface Stored {
  d: MCPEventSubscription;
  r: number;
}

/** Subscriptions per Redis round trip while `list` walks the store. */
const LIST_BATCH = 100;

/**
 * `MCPEventStore` (MCP Events in direct mode, `@tanstack/ai-mcp/events`) on Upstash Redis: webhook
 * subscriptions, their cursors and refresh deadlines survive restarts and are shared by every
 * instance, so a webhook can land on any server. One hash per subscription (document + revision),
 * plus an id index; `update` is a compare-and-set on the revision, retried on a race, so two
 * instances advancing the same cursor never lose a field.
 *
 * The subscription's webhook `secret` is stored as is: use a Redis database you would trust with
 * other credentials.
 *
 * @example
 * ```ts
 * import { createMCPClient } from "@tanstack/ai-mcp";
 * import { upstashMcpEventStore } from "@upstash/agentkit-tanstack-ai/mcp";
 *
 * const mcp = await createMCPClient({
 *   transport: { type: "http", url: "https://mcp.example.com/mcp" },
 *   experimental_events: { store: upstashMcpEventStore() },
 * });
 * ```
 */
export function upstashMcpEventStore(config: UpstashMcpEventStoreConfig = {}): MCPEventStore {
  const redis = config.redis ?? RedisClient.fromEnv();
  addTelemetry(redis, config.enableTelemetry);
  const p = config.prefix ?? "agentkit:tanstack";
  const k = {
    doc: (key: string) => `${p}:mcp:eventSub:${encodeURIComponent(key)}`,
    ids: `${p}:mcp:eventSubIds`,
    all: `${p}:mcp:eventSubs`,
    rev: `${p}:mcp:eventSubRev`,
  };
  const keys = (key: string) => [k.doc(key), k.ids, k.all, k.rev];

  const load = async (key: string): Promise<Stored | undefined> => {
    const hash = await redis.hgetall<{ d: MCPEventSubscription; r: number }>(k.doc(key));
    return hash && hash.d !== undefined ? { d: hash.d, r: Number(hash.r) } : undefined;
  };
  const idOf = (s: MCPEventSubscription) => (typeof s.id === "string" ? s.id : "");

  return {
    async get(key) {
      return (await load(key))?.d;
    },

    async getById(id) {
      const key = await redis.hget<string>(k.ids, id);
      return key === null || key === undefined ? undefined : (await load(String(key).slice(1)))?.d;
    },

    async set(subscription) {
      await redis.eval(WRITE, keys(subscription.key), [
        subscription.key,
        JSON.stringify(subscription),
        "",
        idOf(subscription),
      ]);
    },

    async update(key, patch) {
      for (;;) {
        const stored = await load(key);
        if (!stored) return;
        // `Object.assign` semantics: a field present in the patch replaces the stored one, and a
        // field set to `undefined` is dropped (JSON leaves it out).
        const next = { ...stored.d, ...patch, key } as MCPEventSubscription;
        const id = patch.id === undefined && stored.d.id !== undefined ? stored.d.id : next.id;
        const result = (await redis.eval(WRITE, keys(key), [
          key,
          JSON.stringify(next),
          String(stored.r),
          typeof id === "string" ? id : "",
        ])) as number;
        if (result !== -1) return;
      }
    },

    async delete(key) {
      await redis.eval(DELETE, [k.doc(key), k.ids, k.all], [key]);
    },

    async *list() {
      let cursor = "0";
      do {
        const [next, members] = await redis.sscan(k.all, cursor, { count: LIST_BATCH });
        cursor = String(next);
        for (const member of members) {
          const stored = await load(String(member).slice(1));
          if (stored) yield stored.d;
        }
      } while (cursor !== "0");
    },
  };
}
