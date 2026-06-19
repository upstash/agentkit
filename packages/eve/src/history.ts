import type { ChatHistory, ChatMessage } from "@upstash/agentkit-sdk";
import { fromEveMessages, toEveMessages } from "./messages.js";
import type { EveMessage } from "./types.js";

export interface HistoryHooksConfig {
  /** The AgentKit {@link ChatHistory} backing persistence. */
  history: ChatHistory;
  /** The session whose conversation these hooks read/write. */
  sessionId: string;
}

export interface HistoryHooks {
  /** Load the session's prior turns as Eve-style messages (oldest-first). */
  load(opts?: { limit?: number }): Promise<EveMessage[]>;
  /** Append one or more Eve-style messages to the session. */
  append(message: EveMessage | EveMessage[]): Promise<void>;
}

/**
 * Bridge an AgentKit {@link ChatHistory} to the Eve message shape, bound to a single `sessionId`, so
 * an Eve run can hydrate from prior turns and persist new ones in Eve's message vocabulary.
 *
 * ```ts
 * const hooks = createHistoryHooks({ history, sessionId: "session-1" });
 * const prior = await hooks.load();
 * await hooks.append({ role: "user", content: "Hello" });
 * ```
 */
export function createHistoryHooks(config: HistoryHooksConfig): HistoryHooks {
  const { history, sessionId } = config;
  return {
    async load(opts = {}): Promise<EveMessage[]> {
      const messages = await history.list(sessionId, opts);
      return toEveMessages(messages);
    },
    async append(message): Promise<void> {
      const list = Array.isArray(message) ? message : [message];
      if (list.length === 0) return;
      const chatMessages: ChatMessage[] = fromEveMessages(list);
      await history.append(sessionId, chatMessages);
    },
  };
}
