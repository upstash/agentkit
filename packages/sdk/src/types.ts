/**
 * Shared types for Redis AgentKit.
 *
 * Everything is backed by Upstash Redis. Features take the `@upstash/redis` client directly and own
 * their resources internally — the search-backed features (memory, semantic cache, RAG) create and
 * manage an Upstash Redis Search index for you (queried with the `$smart` fuzzy operator) and expose
 * the raw index handle via a `.searchIndex` getter.
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

/** Logger interface; defaults to a no-op. */
export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
