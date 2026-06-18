import type { ChatMessage, RedisLike } from "./types.js";
import { key, now } from "./utils.js";

export interface ChatHistoryConfig {
  redis: RedisLike;
  /** Key prefix; defaults to `agentkit:chat`. */
  namespace?: string;
  /** Keep at most this many messages per session (older ones are trimmed). */
  maxMessages?: number;
  /** Expire a session's history this many seconds after the last write. */
  ttlSeconds?: number;
}

/**
 * Windowed conversation history backed by a Redis list (one list per session). Messages are stored
 * oldest-first; on each append the list is trimmed to `maxMessages` and (optionally) given a sliding
 * TTL so abandoned sessions expire on their own.
 */
export class ChatHistory {
  private redis: RedisLike;
  private namespace: string;
  private maxMessages?: number;
  private ttlSeconds?: number;

  constructor(config: ChatHistoryConfig) {
    this.redis = config.redis;
    this.namespace = config.namespace ?? "agentkit:chat";
    this.maxMessages = config.maxMessages;
    this.ttlSeconds = config.ttlSeconds;
  }

  private listKey(sessionId: string): string {
    return key(this.namespace, sessionId);
  }

  /** Append one or more messages to a session, stamping `createdAt` when absent. */
  async append(sessionId: string, message: ChatMessage | ChatMessage[]): Promise<void> {
    const messages = Array.isArray(message) ? message : [message];
    if (messages.length === 0) return;
    const k = this.listKey(sessionId);
    const payloads = messages.map((m) => JSON.stringify({ ...m, createdAt: m.createdAt ?? now() }));
    await this.redis.rpush(k, ...payloads);
    if (this.maxMessages !== undefined) {
      await this.redis.ltrim(k, -this.maxMessages, -1);
    }
    if (this.ttlSeconds !== undefined) {
      await this.redis.expire(k, this.ttlSeconds);
    }
  }

  /**
   * Return the session's messages oldest-first. With `limit`, returns the most recent `limit`
   * messages (still oldest-first).
   */
  async list(sessionId: string, opts: { limit?: number } = {}): Promise<ChatMessage[]> {
    const k = this.listKey(sessionId);
    const start = opts.limit !== undefined ? -opts.limit : 0;
    const raw = await this.redis.lrange<string | ChatMessage>(k, start, -1);
    return raw.map(parseMessage);
  }

  /** Number of messages stored for the session. */
  async count(sessionId: string): Promise<number> {
    return this.redis.llen(this.listKey(sessionId));
  }

  /** Delete all history for the session. */
  async clear(sessionId: string): Promise<void> {
    await this.redis.del(this.listKey(sessionId));
  }
}

function parseMessage(raw: string | ChatMessage): ChatMessage {
  if (typeof raw === "string") return JSON.parse(raw) as ChatMessage;
  // Some Redis clients auto-deserialize JSON; tolerate already-parsed objects.
  return raw;
}
