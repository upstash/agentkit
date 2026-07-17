import {
  AgentMemory,
  ChatHistory,
  createSearchToolDefs,
  type SearchToolDefs,
} from "@upstash/agentkit-sdk";
import { Redis } from "@upstash/redis";
import type { SessionContext } from "eve/tools";
import extension from "../extension";

/**
 * `userId` and `sessionId` become Redis key parts, and core key-part validation rejects `:` (the key
 * separator). Derived values like eve principal ids (`eve:app`) or session ids can contain it.
 */
export function sanitizeId(value: string): string {
  return value.replaceAll(":", "_");
}

/** Resolve the per-call user from config (string or function), defaulting to principal → session id. */
export function resolveUserId(ctx: SessionContext): string {
  const { userId } = extension.config;
  if (typeof userId === "string") return sanitizeId(userId);
  if (typeof userId === "function") return sanitizeId(userId(ctx));
  const auth = ctx.session.auth;
  return sanitizeId(auth.current?.principalId ?? auth.initiator?.principalId ?? ctx.session.id);
}

let redisClient: Redis | undefined;

export function redis(): Redis {
  return (redisClient ??= extension.config.redis ?? Redis.fromEnv());
}

let agentMemory: AgentMemory | undefined;

export function memory(): AgentMemory {
  return (agentMemory ??= new AgentMemory({ redis: redis() }));
}

let searchToolDefs: SearchToolDefs | undefined;

/** The core search/aggregate/count defs over the configured index. Throws when `search` is unset. */
export function searchDefs(): SearchToolDefs {
  if (searchToolDefs) return searchToolDefs;
  const search = extension.config.search;
  if (!search) {
    throw new Error(
      "[agentkit] The search/search_aggregate/search_count tools need configuration. Pass " +
        "`search: { schema, indexName }` where the extension is mounted (agent/extensions/<name>.ts), " +
        "or disable these tool slots with `disableTool()` — see the @upstash/agentkit-eve-extension README.",
    );
  }
  searchToolDefs = createSearchToolDefs({
    redis: redis(),
    schema: search.schema,
    ...(search.indexName !== undefined ? { indexName: search.indexName } : {}),
    ...(search.prefix !== undefined ? { prefix: search.prefix } : {}),
    ...(search.defaultLimit !== undefined ? { defaultLimit: search.defaultLimit } : {}),
  });
  return searchToolDefs;
}

/**
 * Module-load-safe variant: the search tools read their (schema-derived) input schemas at module
 * evaluation, which must not throw when `search` is unconfigured or config isn't bound (e.g. the
 * package's `./tools` export imported outside an eve runtime).
 */
export function trySearchDefs(): SearchToolDefs | null {
  try {
    return searchDefs();
  } catch {
    return null;
  }
}

/** The message shape the chat-history hook stores (core `ChatHistory`'s default extractor reads it). */
export interface StoredChatMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

let chats: ChatHistory<StoredChatMessage> | null | undefined;

/** The durable transcript store, or `null` when the consumer passed `chatHistory: false`. */
export function chatHistory(): ChatHistory<StoredChatMessage> | null {
  if (chats !== undefined) return chats;
  const config = extension.config.chatHistory;
  if (config === false) return (chats = null);
  chats = new ChatHistory<StoredChatMessage>({
    redis: redis(),
    ...(config?.prefix !== undefined ? { prefix: config.prefix } : {}),
    ...(config?.indexName !== undefined ? { indexName: config.indexName } : {}),
    ...(config?.ttlSeconds !== undefined ? { ttlSeconds: config.ttlSeconds } : {}),
  });
  return chats;
}

/**
 * Append one message to the session's stored transcript. Core `saveChat` replaces the whole array,
 * so this reads the existing record and writes it back extended — stream events for one session are
 * dispatched in order, so the read-modify-write doesn't race itself.
 */
export async function appendChatMessage(
  ctx: SessionContext,
  role: StoredChatMessage["role"],
  content: string,
): Promise<void> {
  const history = chatHistory();
  if (!history || !content) return;
  const userId = resolveUserId(ctx);
  const sessionId = sanitizeId(ctx.session.id);
  const existing = await history.getChat({ userId, sessionId });
  const messages = existing ? existing.messages : [];
  messages.push({ role, content, createdAt: Date.now() });
  await history.saveChat({
    userId,
    sessionId,
    messages,
    // First user message titles the chat; saveChat keeps the existing title on later writes.
    ...(existing?.title === undefined && role === "user" ? { title: content.slice(0, 80) } : {}),
  });
}
