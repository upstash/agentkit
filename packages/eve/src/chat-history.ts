import { randomUUID } from "node:crypto";
import { ChatHistory } from "@upstash/agentkit-sdk";
import { Redis } from "@upstash/redis";
import { defineHook } from "eve/hooks";
import type { HookContext, HookDefinition } from "eve/hooks";
import type { EveMessage } from "eve/react";

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

export interface ChatHistoryHookConfig extends CreateChatHistoryConfig {
  /**
   * The user/owner scope a chat is stored under — a string, or a function of the hook context (e.g. to
   * derive a per-tenant id). Defaults to `"default"`. The eve session id is used as the chat id.
   */
  userId?: string | ((ctx: HookContext) => string);
}

function textMessage(role: "user" | "assistant", text: string): EveMessage {
  return {
    id: randomUUID(),
    role,
    parts: [{ type: "text", text, state: "done" }],
    metadata: { status: "complete" },
  };
}

/**
 * A ready eve {@link https://eve.dev/docs/guides/hooks hook} that persists the conversation to a
 * Redis-backed {@link ChatHistory} as it runs — drop it in as `agent/hooks/<name>.ts`:
 *
 * ```ts
 * // agent/hooks/persist-chat.ts
 * import { defineChatHistoryHook } from "@upstash/agentkit-eve";
 * export default defineChatHistoryHook({ userId: "demo-user" });
 * ```
 *
 * Why a hook: eve keeps the live session in its Workflow store, pruned 1–30 days after a run completes
 * (per Vercel plan), so Redis is the durable source of truth for long-term history. No single stream
 * event carries the full `EveMessage[]` transcript, so this persists **incrementally** — on
 * `message.received` (the user turn) and each `message.completed` (an assistant text chunk) it appends
 * the message and overwrites the stored list. Persistence errors are swallowed so they never escalate
 * a turn to `turn.failed`. Text-only: tool-call parts aren't reconstructed.
 */
export function defineChatHistoryHook(config: ChatHistoryHookConfig = {}): HookDefinition {
  const { userId, ...historyConfig } = config;
  const history = createChatHistory(historyConfig);
  const resolveUser = (ctx: HookContext): string =>
    typeof userId === "function" ? userId(ctx) : (userId ?? "default");

  const append = async (ctx: HookContext, message: EveMessage): Promise<void> => {
    const user = resolveUser(ctx);
    const sessionId = ctx.session.id;
    const existing = await history.getChat(user, sessionId);
    const messages = [...(existing?.messages ?? []), message];
    const firstPart = message.parts[0];
    const firstText = firstPart && "text" in firstPart ? firstPart.text : undefined;
    const title =
      existing?.title ?? (message.role === "user" ? firstText?.slice(0, 80) : undefined);
    await history.saveChat(user, sessionId, messages, title ? { title } : {});
  };

  return defineHook({
    events: {
      async "message.received"(event, ctx) {
        try {
          const text = event.data.message;
          if (text) await append(ctx, textMessage("user", text));
        } catch (err) {
          console.error("agentkit chat-history hook: failed to save user message", err);
        }
      },
      async "message.completed"(event, ctx) {
        try {
          const text = event.data.message;
          if (text) await append(ctx, textMessage("assistant", text));
        } catch (err) {
          console.error("agentkit chat-history hook: failed to save assistant message", err);
        }
      },
    },
  });
}
