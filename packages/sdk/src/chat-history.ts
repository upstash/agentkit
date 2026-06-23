import { s } from "@upstash/redis";
import type { InferFilterFromSchema, Redis } from "@upstash/redis";
import { ReactiveSearchIndex } from "./reactive-index.js";
import { now } from "./utils.js";

/**
 * Reject an empty/missing id. `userId` and `sessionId` are the only tenant boundary, so a blank one
 * would silently mis-scope a chat (or, for `userId`, let any caller read/overwrite another user's chat).
 */
function assertId(value: string | undefined, name: string): asserts value is string {
  if (value === undefined || value === "") {
    throw new Error(`ChatHistory: \`${name}\` is required and must be a non-empty string.`);
  }
}

/** Lightweight summary of a chat, returned by list/search (no raw messages). */
export interface ChatSummary {
  /** The chat/session id (the AI SDK `useChat` id, or an auto-generated one). */
  sessionId: string;
  /** The user/owner this chat belongs to. */
  userId: string;
  /** Human-readable title (e.g. derived from the first user message). */
  title?: string;
  createdAt: number;
  updatedAt: number;
  /** Number of stored messages. */
  messageCount: number;
}

/** A full chat record: its summary plus the raw stored messages and optional metadata. */
export interface ChatRecord<TMessage = unknown> extends ChatSummary {
  /** The raw transcript exactly as the framework needs it (e.g. AI SDK `UIMessage[]`). Not indexed. */
  messages: TMessage[];
  /** Arbitrary metadata (e.g. an eve session cursor for live resume). Not indexed. */
  metadata?: Record<string, unknown>;
}

/** A search hit: a chat summary plus its BM25 relevance score. */
export interface ChatSearchHit extends ChatSummary {
  score: number;
}

/** Merged, searchable text pulled out of a message list. */
export interface ExtractedText {
  userMessages: string;
  modelMessages: string;
}

export interface ChatHistoryConfig<TMessage = unknown> {
  /** The Upstash Redis client. The search index is created and managed internally. */
  redis: Redis;
  /** Base key prefix for stored chats; defaults to `agentkit:chat`. */
  prefix?: string;
  /** Redis Search index name. Defaults to the (identifier-safe) `prefix`. */
  indexName?: string;
  /** Optional TTL (seconds) per chat. The search index self-syncs when a chat key expires. Omit for no expiry. */
  ttlSeconds?: number;
  /**
   * Merge messages into the two indexed text fields. The default handles the `UIMessage`/`EveMessage`
   * convention (`{ role, parts: [{ type: "text", text }] }`), so adapters rarely override it.
   */
  extractText?: (messages: TMessage[]) => ExtractedText;
}

interface ChatDoc<TMessage> {
  userId: string;
  sessionId: string;
  /** Indexed: all user-message text, merged. */
  userMessages: string;
  /** Indexed: all assistant/model-message text, merged. */
  modelMessages: string;
  /** Not indexed: the raw transcript. */
  messages: TMessage[];
  title?: string;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

type TextLike = { role?: string; parts?: { type?: string; text?: string }[]; content?: unknown };

/** Pull the plain text out of one `UIMessage`/`EveMessage`-shaped message. */
function messageText(message: TextLike): string {
  if (Array.isArray(message.parts)) {
    return message.parts
      .filter((p) => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join(" ")
      .trim();
  }
  return typeof message.content === "string" ? message.content.trim() : "";
}

/** Default text extractor: merge user-role text and assistant/model-role text into two strings. */
function defaultExtract(messages: unknown[]): ExtractedText {
  const user: string[] = [];
  const model: string[] = [];
  for (const m of messages as TextLike[]) {
    const text = messageText(m);
    if (!text) continue;
    if (m.role === "user") user.push(text);
    else if (m.role === "assistant" || m.role === "model") model.push(text);
  }
  return { userMessages: user.join("\n"), modelMessages: model.join("\n") };
}

const ChatHistorySchema = s.object({
  userId: s.string().noTokenize(),
  sessionId: s.string().noTokenize(),
  userMessages: s.string(),
  modelMessages: s.string(),
});

/**
 * Durable chat history backed by **Upstash Redis Search** — the source of truth for a conversation's
 * transcript, framework-agnostic and generic over the message type `TMessage` (the AI SDK adapter
 * specializes it to `UIMessage`, eve to `EveMessage`).
 *
 * Each chat is one JSON doc at `agentkit:chat:<userId>:<sessionId>` — keyed per user, so two users
 * can never collide on a `sessionId`. The index covers four fields: `userId` + `sessionId` (exact-match
 * filters) and `userMessages` + `modelMessages` (fuzzy `$smart` text). The raw `messages` array (and
 * `metadata`) ride along in the same doc but are **not** indexed. So you can filter by `userId` to list
 * a user's chats, and `$smart`-search within what the user or the model said.
 */
export class ChatHistory<TMessage = unknown> {
  private redis: Redis;
  private keyPrefix: string;
  private index: ReactiveSearchIndex<typeof ChatHistorySchema>;
  private ttlSeconds?: number;
  private extract: (messages: TMessage[]) => ExtractedText;

  constructor(config: ChatHistoryConfig<TMessage>) {
    this.redis = config.redis;
    const prefix = config.prefix ?? "agentkit:chat";
    // Index names must be identifier-safe; the key prefix keeps the human-readable base prefix.
    const indexName = config.indexName ?? prefix.replace(/[^a-zA-Z0-9_]/g, "_");
    this.keyPrefix = `${prefix}:`;
    this.index = new ReactiveSearchIndex({
      redis: this.redis,
      indexName,
      prefix: this.keyPrefix,
      schema: ChatHistorySchema,
    });
    this.ttlSeconds = config.ttlSeconds;
    this.extract = config.extractText ?? (defaultExtract as (m: TMessage[]) => ExtractedText);
  }

  /** The underlying (reactive) Upstash Redis Search index handle. */
  get searchIndex() {
    return this.index;
  }

  /**
   * Per-user key: each user has its own keyspace, so two users can never collide on a `sessionId` and
   * one user's write can't reach another's chat. The `userId` is the tenant boundary, structurally.
   */
  private keyFor(userId: string, sessionId: string): string {
    return `${this.keyPrefix}${userId}:${sessionId}`;
  }

  private toSummary(doc: ChatDoc<TMessage>): ChatSummary {
    return {
      sessionId: doc.sessionId,
      userId: doc.userId,
      ...(doc.title !== undefined ? { title: doc.title } : {}),
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      messageCount: Array.isArray(doc.messages) ? doc.messages.length : 0,
    };
  }

  private toRecord(doc: ChatDoc<TMessage>): ChatRecord<TMessage> {
    return {
      ...this.toSummary(doc),
      messages: doc.messages ?? [],
      ...(doc.metadata !== undefined ? { metadata: doc.metadata } : {}),
    };
  }

  /**
   * Persist a chat by **replacing** its whole message array with the one you pass — `saveChat` is an
   * overwrite, not an append, so hand it the complete transcript (there's no delta to merge). Upserts
   * the chat if new, re-derives the searchable text, and bumps `updatedAt`. `sessionId` is the AI SDK
   * `useChat` id (or any stable id you choose). Typically you call this server-side once a turn
   * finishes (e.g. the AI SDK route's `onFinish`), with the full request + reply message list.
   *
   * The chat lives under a per-user key (`<prefix>:<userId>:<sessionId>`), so a write only ever
   * touches **this** user's chat — another user reusing the same `sessionId` has a separate chat.
   */
  async saveChat(params: {
    /** The chat owner. Must be unique per user (it's the tenant boundary). Required, non-empty. */
    userId: string;
    /** The chat/session id (the AI SDK `useChat` id, or any stable id). Required, non-empty. */
    sessionId: string;
    /** The full transcript (the whole conversation — there is no delta merge). */
    messages: TMessage[];
    title?: string;
    metadata?: Record<string, unknown>;
  }): Promise<ChatRecord<TMessage>> {
    const { userId, sessionId, messages } = params;
    assertId(userId, "userId");
    assertId(sessionId, "sessionId");
    // Writes go straight to Redis — no index needed; the index is provisioned on the first read.
    const existing = await this.getDoc(userId, sessionId);
    const ts = now();
    const { userMessages, modelMessages } = this.extract(messages);
    const doc: ChatDoc<TMessage> = {
      userId,
      sessionId,
      userMessages,
      modelMessages,
      messages,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
      ...((params.title ?? existing?.title) ? { title: params.title ?? existing?.title } : {}),
      ...(params.metadata || existing?.metadata
        ? { metadata: { ...existing?.metadata, ...params.metadata } }
        : {}),
    };
    await this.redis.json.set(this.keyFor(userId, sessionId), "$", doc as never);
    if (this.ttlSeconds !== undefined)
      await this.redis.expire(this.keyFor(userId, sessionId), this.ttlSeconds);
    return this.toRecord(doc);
  }

  private async getDoc(userId: string, sessionId: string): Promise<ChatDoc<TMessage> | null> {
    const doc = await this.redis.json.get<ChatDoc<TMessage>[]>(this.keyFor(userId, sessionId), "$");
    return Array.isArray(doc) ? (doc[0] ?? null) : ((doc as ChatDoc<TMessage> | null) ?? null);
  }

  /** Fetch a single chat (full transcript), or `null` if this user has no chat with that `sessionId`. */
  async getChat(params: {
    userId: string;
    sessionId: string;
  }): Promise<ChatRecord<TMessage> | null> {
    const { userId, sessionId } = params;
    assertId(userId, "userId");
    assertId(sessionId, "sessionId");
    const doc = await this.getDoc(userId, sessionId);
    return doc ? this.toRecord(doc) : null;
  }

  /**
   * Run a filtered query (the index is provisioned reactively on first read) and return its rows. The
   * typed index narrows `data` to the indexed schema fields, but at runtime `query` returns the **full
   * stored JSON** as `data` (verified against live Redis). This one cast bridges that — everywhere
   * else `r.data` is a fully-typed {@link ChatDoc}.
   */
  private async queryChats(
    filter: InferFilterFromSchema<typeof ChatHistorySchema>,
    limit?: number,
  ): Promise<{ score: number; data: ChatDoc<TMessage> }[]> {
    return this.index.query({
      filter,
      ...(limit !== undefined ? { limit } : {}),
    }) as unknown as Promise<{ score: number; data: ChatDoc<TMessage> }[]>;
  }

  /** List a user's chats (summaries only), newest-updated first. Filters the index by `userId`. */
  async listChats(params: { userId: string; limit?: number }): Promise<ChatSummary[]> {
    const { userId } = params;
    assertId(userId, "userId");
    const rows = await this.queryChats({ userId: { $eq: userId } }, params.limit);
    const summaries = rows.map((r) => this.toSummary(r.data));
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return summaries;
  }

  /**
   * Fuzzily search a user's chats by what was said. `target` picks which side to match: `"user"`,
   * `"model"`, or `"both"` (default). Returns summaries with BM25 scores, most relevant first.
   */
  async searchChats(params: {
    userId: string;
    query: string;
    limit?: number;
    minScore?: number;
    target?: "user" | "model" | "both";
  }): Promise<ChatSearchHit[]> {
    const { userId, query } = params;
    assertId(userId, "userId");
    const target = params.target ?? "both";
    const userClause = { userId: { $eq: userId } };
    const filter: InferFilterFromSchema<typeof ChatHistorySchema> =
      target === "user"
        ? { $and: [userClause, { userMessages: { $smart: query } }] }
        : target === "model"
          ? { $and: [userClause, { modelMessages: { $smart: query } }] }
          : {
              $and: [
                userClause,
                {
                  $or: [{ userMessages: { $smart: query } }, { modelMessages: { $smart: query } }],
                },
              ],
            };
    const rows = await this.queryChats(filter, params.limit);
    const minScore = params.minScore ?? 0;
    return rows
      .filter((r) => r.score >= minScore)
      .map((r) => ({ ...this.toSummary(r.data), score: r.score }));
  }

  /** Delete this user's chat (also removes it from the index). No-op if it doesn't exist. */
  async deleteChat(params: { userId: string; sessionId: string }): Promise<void> {
    const { userId, sessionId } = params;
    assertId(userId, "userId");
    assertId(sessionId, "sessionId");
    await this.redis.del(this.keyFor(userId, sessionId));
  }
}
