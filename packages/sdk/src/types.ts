/**
 * Shared types and structural interfaces for Redis AgentKit.
 *
 * The SDK never imports `@upstash/redis` at runtime. Instead it relies on the structural interfaces
 * below, so any compatible client (including the in-memory test doubles in
 * `@upstash/agentkit-sdk/testing`) can be injected. This keeps the core logic fully unit-testable
 * without a network connection.
 *
 * Everything is backed by Upstash Redis. The "semantic" features (memory recall, semantic cache,
 * RAG retrieval) are powered by {@link SearchStore} — Upstash Redis Search with its `$smart` fuzzy
 * operator (layered phrase / term / fuzzy / prefix matching, BM25-scored) — rather than embeddings.
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

/** Scalar values usable as exact-match filter constraints in a {@link SearchQuery}. */
export type FilterValue = string | number | boolean;

/** A document stored in a {@link SearchStore}. */
export interface SearchDocument {
  id: string;
  /** The free text that fuzzy `$smart` queries match against. */
  content: string;
  /** Non-searchable fields stored alongside and returned with hits. */
  metadata?: Record<string, unknown>;
  /** Exact-match fields (e.g. a scope/user id) ANDed with the text match at query time. */
  filters?: Record<string, FilterValue>;
}

export interface SearchQuery {
  /** The natural-language query, matched against document `content` via `$smart`. */
  query: string;
  /** Maximum number of hits to return. */
  topK?: number;
  /** Exact-match constraints ANDed with the fuzzy text match. */
  filters?: Record<string, FilterValue>;
}

export interface SearchHit {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
  /**
   * Relevance score. With the in-memory store this is normalized to `[0, 1]`; with real Upstash
   * Redis Search it is the BM25 score, so tune any `minScore` thresholds to your data.
   */
  score: number;
}

/**
 * Minimal structural interface over a fuzzy text index (Upstash Redis Search). The in-memory
 * `MemorySearchStore` test double implements it too, so the SDK's search-backed features can run
 * fully offline.
 */
export interface SearchStore {
  upsert(documents: SearchDocument[]): Promise<void>;
  search(query: SearchQuery): Promise<SearchHit[]>;
  delete(ids: string[]): Promise<void>;
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
