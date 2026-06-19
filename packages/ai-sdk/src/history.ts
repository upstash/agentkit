import type { ChatHistory, ChatMessage } from "@upstash/agentkit-sdk";
import { fromCoreMessages, toCoreMessages } from "./messages.js";
import type { CoreMessageLike } from "./types.js";

export interface HistoryStoreConfig {
  /** The AgentKit {@link ChatHistory} instance backing persistence. */
  history: ChatHistory;
}

export interface HistoryStore {
  /** Load a session's messages as AI-SDK-style core messages (oldest-first). */
  load(sessionId: string, opts?: { limit?: number }): Promise<CoreMessageLike[]>;
  /** Append AI-SDK-style core messages to a session. */
  save(sessionId: string, messages: CoreMessageLike[]): Promise<void>;
  /** Convenience: append the assistant's generated text as one assistant message. */
  saveResult(sessionId: string, result: { text: string }): Promise<void>;
}

/**
 * Bridges an AgentKit {@link ChatHistory} to the AI SDK message shape so you can hydrate a model call
 * with prior turns and persist the model's reply back, all in the AI SDK's `CoreMessage` vocabulary.
 *
 * ```ts
 * const store = createHistoryStore({ history });
 * const prior = await store.load(sessionId);
 * const result = await generateText({ model, messages: [...prior, { role: "user", content: input }] });
 * await store.save(sessionId, [{ role: "user", content: input }]);
 * await store.saveResult(sessionId, result);
 * ```
 */
export function createHistoryStore(config: HistoryStoreConfig): HistoryStore {
  const { history } = config;
  return {
    async load(sessionId, opts = {}) {
      const messages = await history.list(sessionId, opts);
      return toCoreMessages(messages);
    },
    async save(sessionId, messages) {
      const chatMessages: ChatMessage[] = fromCoreMessages(messages);
      if (chatMessages.length === 0) return;
      await history.append(sessionId, chatMessages);
    },
    async saveResult(sessionId, result) {
      await history.append(sessionId, { role: "assistant", content: result.text });
    },
  };
}
