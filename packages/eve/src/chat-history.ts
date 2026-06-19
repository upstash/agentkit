import type { EveMessage } from "eve/react";
import { ChatHistory } from "@upstash/agentkit-sdk";
import { Redis } from "@upstash/redis";

export interface CreateChatHistoryConfig {
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /** Key prefix. Defaults to `agentkit:chat`. */
  namespace?: string;
  /** Optional TTL (seconds) per chat. Omit for no expiry. */
  ttlSeconds?: number;
}

/**
 * A Redis-backed {@link ChatHistory} typed for eve's `EveMessage`s (the AI SDK `UIMessage` shape) —
 * the durable source of truth for a conversation's transcript. `redis` defaults to `Redis.fromEnv()`.
 *
 * eve keeps live sessions in its Workflow store, but that's pruned 1–30 days after a run completes
 * (per your Vercel plan), so persist the transcript here for durable history and list/resume. Save
 * the final `data.messages` plus the `session` cursor (in `metadata.session`) when a turn settles;
 * resume a stored chat by passing that cursor to `useEveAgent({ initialSession })`, and render the
 * transcript from {@link ChatHistory.getChat}.
 *
 * ```ts
 * import { createChatHistory } from "@upstash/agentkit-eve";
 * const history = createChatHistory();
 *
 * // when a turn settles (e.g. via a server route the client posts the snapshot to):
 * await history.saveChat(userId, chatId, snapshot.data.messages, {
 *   metadata: { session: snapshot.session }, // cursor for live resume within eve's retention window
 * });
 *
 * const chats = await history.listChats(userId); // sidebar
 * const chat = await history.getChat(userId, chatId); // chat.messages + chat.metadata.session
 * ```
 */
export function createChatHistory(config: CreateChatHistoryConfig = {}): ChatHistory<EveMessage> {
  const { redis, ...rest } = config;
  return new ChatHistory<EveMessage>({ redis: redis ?? Redis.fromEnv(), ...rest });
}
