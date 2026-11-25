import { Redis } from "@upstash/redis";
import { addTelemetry } from "./telemetry.js";

/** Options of {@link createActiveStreamStore}. */
export interface ActiveStreamStoreConfig {
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /** Key prefix; a chat's record is at `<prefix>:<chatId>`. @default "agentkit:activeStream" */
  prefix?: string;
  /**
   * Lifetime of a record. Match resumable-stream's own (24 hours), so a record never outlives the
   * stream it points at by much.
   * @default 86400
   */
  ttlSeconds?: number;
  /** Report this package in the redis client's telemetry header. @default true */
  enableTelemetry?: boolean;
}

/** Which resumable stream, if any, is active for each chat. */
export interface ActiveStreamStore {
  /** Records `streamId` as the chat's active stream, replacing any previous one. */
  set: (chatId: string, streamId: string) => Promise<void>;
  /** The chat's active stream id, or `null`. */
  get: (chatId: string) => Promise<string | null>;
  /**
   * Clears the chat's record only if it still points at `expectedStreamId`, atomically, and
   * returns whether it did. A stream that finishes after a newer one started for the same chat
   * leaves the newer record alone.
   */
  clear: (chatId: string, expectedStreamId: string) => Promise<boolean>;
}

/**
 * Compare-and-delete. `allow-key-locking` makes Upstash lock only the declared key; it must stay on
 * the first line.
 */
const CLEAR_IF_MATCHES = `#!lua flags=allow-key-locking
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

/**
 * Stored values get a `~` in front: `@upstash/redis` JSON-parses what it reads, so a stream id such
 * as `"007"` would otherwise come back as the number 7.
 */
const MARK = "~";

export function assertId(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

/**
 * A registry of the active resumable stream per chat, on Upstash Redis: the "active stream id" the
 * AI SDK resume flow keeps next to a chat. Set it when a stream starts, read it in the resume
 * endpoint, and clear it when the stream ends:
 *
 * ```ts
 * const activeStreams = createActiveStreamStore();
 * await activeStreams.set(chatId, streamId);          // POST, in consumeSseStream
 * const streamId = await activeStreams.get(chatId);   // GET /stream, 204 when null
 * await activeStreams.clear(chatId, streamId);        // when the stream ends
 * ```
 *
 * Each call is one Redis command.
 */
export function createActiveStreamStore(config: ActiveStreamStoreConfig = {}): ActiveStreamStore {
  const {
    redis = Redis.fromEnv(),
    prefix = "agentkit:activeStream",
    ttlSeconds = 24 * 60 * 60,
    enableTelemetry,
  } = config;
  addTelemetry(redis, enableTelemetry);
  const keyOf = (chatId: string) => {
    assertId(chatId, "chatId");
    return `${prefix}:${chatId}`;
  };

  return {
    set: async (chatId, streamId) => {
      assertId(streamId, "streamId");
      await redis.set(keyOf(chatId), MARK + streamId, { ex: ttlSeconds });
    },

    get: async (chatId) => {
      const value = await redis.get<unknown>(keyOf(chatId));
      if (typeof value !== "string" || !value.startsWith(MARK)) return null;
      return value.slice(MARK.length);
    },

    clear: async (chatId, expectedStreamId) => {
      assertId(expectedStreamId, "expectedStreamId");
      const deleted = await redis.eval<[string], number>(
        CLEAR_IF_MATCHES,
        [keyOf(chatId)],
        [MARK + expectedStreamId],
      );
      return Number(deleted) === 1;
    },
  };
}
