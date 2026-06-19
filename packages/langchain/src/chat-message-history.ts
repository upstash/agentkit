import { ChatHistory, type ChatHistoryConfig } from "@upstash/agentkit-sdk";
import { fromLangChainMessage, toLangChainMessage } from "./messages.js";
import type { BaseMessageLike, ChatMessageHistoryLike } from "./types.js";

export interface RedisChatMessageHistoryConfig extends ChatHistoryConfig {
  /** Conversation/session this history is bound to. Each session is an isolated Redis list. */
  sessionId: string;
}

/**
 * A LangChain-style chat message history backed by the AgentKit {@link ChatHistory} (Upstash Redis).
 *
 * It mirrors LangChain's `BaseChatMessageHistory` surface (`getMessages`, `addMessage`,
 * `addUserMessage`, `addAIMessage`, `clear`) without extending the real base class, so it can be
 * dropped into a LangChain `RunnableWithMessageHistory` / memory while staying fully offline-testable.
 * Messages are converted to/from AgentKit {@link ChatMessage}s on the way in and out, and windowing
 * + TTL behavior comes for free from the underlying `ChatHistory`.
 *
 * @example
 * ```ts
 * const history = new RedisChatMessageHistory({ redis, sessionId: "user-42", maxMessages: 50 });
 * await history.addUserMessage("Hello");
 * await history.addAIMessage("Hi there!");
 * const messages = await history.getMessages(); // LangChain-style messages
 * ```
 */
export class RedisChatMessageHistory implements ChatMessageHistoryLike {
  private history: ChatHistory;
  private sessionId: string;

  constructor(config: RedisChatMessageHistoryConfig) {
    const { sessionId, ...rest } = config;
    this.sessionId = sessionId;
    this.history = new ChatHistory(rest);
  }

  /** Return the session's messages oldest-first, as LangChain-style messages. */
  async getMessages(): Promise<BaseMessageLike[]> {
    const stored = await this.history.list(this.sessionId);
    return stored.map(toLangChainMessage);
  }

  /** Append a single LangChain-style message. */
  async addMessage(message: BaseMessageLike): Promise<void> {
    await this.history.append(this.sessionId, fromLangChainMessage(message));
  }

  /** Append several LangChain-style messages in order. */
  async addMessages(messages: BaseMessageLike[]): Promise<void> {
    if (messages.length === 0) return;
    await this.history.append(this.sessionId, messages.map(fromLangChainMessage));
  }

  /** Convenience: append a human/user message. */
  async addUserMessage(text: string): Promise<void> {
    await this.history.append(this.sessionId, { role: "user", content: text });
  }

  /** Convenience: append an AI/assistant message. */
  async addAIMessage(text: string): Promise<void> {
    await this.history.append(this.sessionId, { role: "assistant", content: text });
  }

  /** Delete all messages for this session. */
  async clear(): Promise<void> {
    await this.history.clear(this.sessionId);
  }
}
