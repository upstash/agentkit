import type { ChatHistory } from "@upstash/agentkit-sdk";
import { fromTanStackMessage, toTanStackMessages } from "./messages.js";
import type { TanStackMessage } from "./types.js";

export interface ChatHistoryAdapterConfig {
  /** The AgentKit {@link ChatHistory} instance backing persistence. */
  history: ChatHistory;
  /** When loading, return at most this many of the most recent messages. */
  limit?: number;
}

/**
 * A persistent chat-history store shaped to plug into a TanStack chat store/options. It bridges
 * TanStack-AI-style messages to AgentKit's {@link ChatHistory}, converting on the way in and out so
 * conversations survive across requests and processes.
 */
export interface ChatHistoryAdapter {
  /** Load a session's messages oldest-first (optionally windowed by `limit`). */
  getMessages(sessionId: string): Promise<TanStackMessage[]>;
  /** Append one message to a session. */
  addMessage(sessionId: string, message: TanStackMessage): Promise<void>;
  /** Append several messages to a session in order. */
  addMessages(sessionId: string, messages: TanStackMessage[]): Promise<void>;
  /** Delete all stored history for a session. */
  clear(sessionId: string): Promise<void>;
}

/**
 * Build a {@link ChatHistoryAdapter} backed by AgentKit's {@link ChatHistory}. Pass the returned
 * object wherever your TanStack chat store expects load/save hooks.
 *
 * @example
 * ```ts
 * const adapter = createChatHistoryAdapter({ history: new ChatHistory({ redis }) });
 * const messages = await adapter.getMessages("session-1");
 * await adapter.addMessage("session-1", { role: "user", content: "Hi" });
 * ```
 */
export function createChatHistoryAdapter(config: ChatHistoryAdapterConfig): ChatHistoryAdapter {
  const { history, limit } = config;
  return {
    async getMessages(sessionId: string): Promise<TanStackMessage[]> {
      const stored = await history.list(sessionId, limit !== undefined ? { limit } : {});
      return toTanStackMessages(stored);
    },
    async addMessage(sessionId: string, message: TanStackMessage): Promise<void> {
      await history.append(sessionId, fromTanStackMessage(message));
    },
    async addMessages(sessionId: string, messages: TanStackMessage[]): Promise<void> {
      if (messages.length === 0) return;
      await history.append(sessionId, messages.map(fromTanStackMessage));
    },
    async clear(sessionId: string): Promise<void> {
      await history.clear(sessionId);
    },
  };
}
