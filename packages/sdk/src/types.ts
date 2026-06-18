/**
 * Shared types and structural interfaces for Redis AgentKit.
 *
 * The SDK never imports `@upstash/redis` or `@upstash/vector` at runtime. Instead it relies on the
 * structural interfaces below, so any compatible client (including the in-memory test doubles in
 * `@upstash/agentkit-sdk/testing`) can be injected. This keeps the core logic fully unit-testable
 * without a network connection.
 */

/** A chat message in a conversation. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Optional name (e.g. tool name, or participant name). */
  name?: string;
  /** Set when `role === "tool"` to correlate with the originating tool call. */
  toolCallId?: string;
  /** Arbitrary metadata carried alongside the message. */
  metadata?: Record<string, unknown>;
  /** Unix epoch milliseconds. Populated automatically when appended. */
  createdAt?: number;
}

/**
 * Turns text into embedding vectors. Inject your own (OpenAI, Cohere, a local model, …) or rely on
 * the vector store's built-in embedding by leaving it unset.
 */
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
  /** Optional identifier used for telemetry/cache keys. */
  readonly model?: string;
}

/** A record stored in a {@link VectorStore}. */
export interface VectorRecord {
  id: string;
  /** Pre-computed embedding. Provide this OR `data` (for built-in embedding). */
  vector?: number[];
  /** Raw text, embedded by the store itself when no `vector` is given. */
  data?: string;
  metadata?: Record<string, unknown>;
}

export interface VectorQuery {
  vector?: number[];
  data?: string;
  topK: number;
  namespace?: string;
  /** Provider-specific metadata filter expression. */
  filter?: string;
  includeMetadata?: boolean;
  includeData?: boolean;
}

export interface VectorMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
  data?: string;
}

/** Minimal structural interface over a vector index (e.g. `@upstash/vector`). */
export interface VectorStore {
  upsert(records: VectorRecord[], opts?: { namespace?: string }): Promise<void>;
  query(query: VectorQuery): Promise<VectorMatch[]>;
  delete(ids: string[], opts?: { namespace?: string }): Promise<void>;
}

/** Options accepted by Redis string writes. */
export interface RedisSetOptions {
  /** Expiry in seconds. */
  ex?: number;
  /** Expiry in milliseconds. */
  px?: number;
  /** Only set if the key does not exist. */
  nx?: boolean;
  /** Only set if the key already exists. */
  xx?: boolean;
}

/**
 * Minimal structural interface over a Redis client. This is the subset of the `@upstash/redis`
 * client surface the SDK actually uses; the in-memory `MemoryRedis` test double implements it too.
 */
export interface RedisLike {
  get<T = string>(key: string): Promise<T | null>;
  set<T = string>(key: string, value: T, opts?: RedisSetOptions): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  exists(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  incr(key: string): Promise<number>;

  // lists
  rpush<T = string>(key: string, ...values: T[]): Promise<number>;
  lpush<T = string>(key: string, ...values: T[]): Promise<number>;
  lrange<T = string>(key: string, start: number, stop: number): Promise<T[]>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  llen(key: string): Promise<number>;

  // hashes
  hset<T = unknown>(key: string, kv: Record<string, T>): Promise<number>;
  hget<T = unknown>(key: string, field: string): Promise<T | null>;
  hgetall<T = unknown>(key: string): Promise<Record<string, T> | null>;
  hdel(key: string, ...fields: string[]): Promise<number>;

  // sorted sets (used by telemetry)
  zadd<T = string>(key: string, ...members: { score: number; member: T }[]): Promise<number | null>;
  zrange<T = string>(key: string, start: number, stop: number): Promise<T[]>;

  // scanning
  scan(
    cursor: string | number,
    opts?: { match?: string; count?: number },
  ): Promise<[string, string[]]>;
}

/** Logger interface; defaults to a no-op. */
export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
