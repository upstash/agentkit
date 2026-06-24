import type { UIMessage } from "ai";
import { ChatHistory } from "@upstash/agentkit-sdk";
import { Redis } from "@upstash/redis";

export interface CreateChatHistoryConfig {
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /** Base key prefix. Defaults to `agentkit:chat`. */
  prefix?: string;
  /** Redis Search index name. Defaults to the (identifier-safe) `prefix`. */
  indexName?: string;
  /** Optional TTL (seconds) per chat. Omit for no expiry. */
  ttlSeconds?: number;
}

/**
 * A Redis-backed {@link ChatHistory} typed for AI SDK `UIMessage`s — the durable source of truth for
 * your chats. `redis` defaults to `Redis.fromEnv()`. Use it to load a chat for `useChat`, list a
 * user's chats, and persist the final messages from your route's `onFinish`.
 *
 * ```ts
 * import { createChatHistory } from "@upstash/agentkit-ai-sdk";
 * import { createUIMessageStreamResponse, toUIMessageStream } from "ai";
 * const history = createChatHistory();
 *
 * // server route — persist the whole conversation when the stream finishes
 * return createUIMessageStreamResponse({
 *   stream: toUIMessageStream({
 *     stream: result.stream,
 *     originalMessages: messages,
 *     onFinish: ({ messages }) => history.saveChat({ userId, sessionId: chatId, messages }),
 *   }),
 * });
 *
 * // page loader — seed useChat with the stored transcript
 * const chat = await history.getChat({ userId, sessionId: chatId });
 * // <Chat id={chatId} initialMessages={chat?.messages ?? []} />
 *
 * // sidebar — list the user's chats (summaries, no messages)
 * const chats = await history.listChats({ userId });
 * ```
 */
export function createChatHistory(config: CreateChatHistoryConfig = {}): ChatHistory<UIMessage> {
  const { redis, ...rest } = config;
  return new ChatHistory<UIMessage>({ redis: redis ?? Redis.fromEnv(), ...rest });
}
