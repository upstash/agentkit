import { randomUUID } from "node:crypto";
import { s } from "@upstash/redis";
import type { Redis } from "@upstash/redis";
import { withIndex, type SearchIndexHandle } from "./search-index.js";
import { now } from "./utils.js";

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
  /** Key prefix + index name base; defaults to `agentkit:chat`. */
  namespace?: string;
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

/** The schema type accepted by `redis.search.index`. */
type SearchSchema = NonNullable<Parameters<Redis["search"]["index"]>[0]["schema"]>;

/**
 * Durable chat history backed by **Upstash Redis Search** — the source of truth for a conversation's
 * transcript, framework-agnostic and generic over the message type `TMessage` (the AI SDK adapter
 * specializes it to `UIMessage`, eve to `EveMessage`).
 *
 * Each chat is one JSON doc at `agentkit:chat:<sessionId>` with an index over four fields:
 * `userId` + `sessionId` (exact-match filters) and `userMessages` + `modelMessages` (fuzzy `$smart`
 * text). The raw `messages` array (and `metadata`) ride along in the same doc but are **not** indexed.
 * So you can filter by `userId` to list a user's chats, and `$smart`-search within what the user or
 * the model said.
 */
export class ChatHistory<TMessage = unknown> {
  private redis: Redis;
  private namespace: string;
  private name: string;
  private prefix: string;
  private schema: SearchSchema;
  private index: SearchIndexHandle;
  private ttlSeconds?: number;
  private extract: (messages: TMessage[]) => ExtractedText;
  private created?: Promise<void>;

  constructor(config: ChatHistoryConfig<TMessage>) {
    this.redis = config.redis;
    this.namespace = config.namespace ?? "agentkit:chat";
    this.name = this.namespace.replace(/[^a-zA-Z0-9_]/g, "_");
    this.prefix = `${this.namespace}:`;
    this.schema = s.object({
      userId: s.string().noTokenize(),
      sessionId: s.string().noTokenize(),
      userMessages: s.string(),
      modelMessages: s.string(),
    }) as SearchSchema;
    this.index = this.redis.search.index({ name: this.name, schema: this.schema });
    this.ttlSeconds = config.ttlSeconds;
    this.extract = config.extractText ?? (defaultExtract as (m: TMessage[]) => ExtractedText);
  }

  /** The underlying Upstash Redis Search index handle (`query`, `count`, `waitIndexing`, `drop`, …). */
  get searchIndex(): SearchIndexHandle {
    return this.index;
  }

  private keyFor(sessionId: string): string {
    return this.prefix + sessionId;
  }

  private createIndex(): Promise<void> {
    return this.redis.search
      .createIndex({ name: this.name, dataType: "json", prefix: this.prefix, schema: this.schema })
      .then(() => undefined)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/already exists/i.test(msg)) throw err;
      });
  }

  /** Create the index once on write (idempotent), so docs start indexing as they're saved. */
  private ensure(): Promise<void> {
    if (!this.created) this.created = this.createIndex();
    return this.created;
  }

  /** Create the index and wait until it's queryable — the recovery path for {@link withIndex}. */
  private async provision(): Promise<void> {
    this.created = undefined;
    await this.ensure();
    await this.index.waitIndexing();
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
   * Overwrite a chat's messages with the full array (the frontend sends the whole conversation, so
   * there's no delta to merge). Upserts the chat if new. Re-derives the searchable text and bumps
   * `updatedAt`. `sessionId` is the AI SDK `useChat` id (or any stable id you choose).
   */
  async saveChat(
    userId: string,
    sessionId: string,
    messages: TMessage[],
    opts: { title?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<ChatRecord<TMessage>> {
    await this.ensure();
    const existing = await this.getDoc(sessionId);
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
      ...((opts.title ?? existing?.title) ? { title: opts.title ?? existing?.title } : {}),
      ...(opts.metadata || existing?.metadata
        ? { metadata: { ...existing?.metadata, ...opts.metadata } }
        : {}),
    };
    await this.redis.json.set(this.keyFor(sessionId), "$", doc as never);
    if (this.ttlSeconds !== undefined)
      await this.redis.expire(this.keyFor(sessionId), this.ttlSeconds);
    return this.toRecord(doc);
  }

  /** Create a new (optionally pre-seeded) chat. Generates a `sessionId` when omitted. */
  async createChat(
    userId: string,
    opts: {
      sessionId?: string;
      title?: string;
      messages?: TMessage[];
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<ChatRecord<TMessage>> {
    return this.saveChat(userId, opts.sessionId ?? randomUUID(), opts.messages ?? [], {
      ...(opts.title !== undefined ? { title: opts.title } : {}),
      ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
    });
  }

  private async getDoc(sessionId: string): Promise<ChatDoc<TMessage> | null> {
    const doc = await this.redis.json.get<ChatDoc<TMessage>[]>(this.keyFor(sessionId), "$");
    return Array.isArray(doc) ? (doc[0] ?? null) : ((doc as ChatDoc<TMessage> | null) ?? null);
  }

  /** Fetch a single chat (full transcript), or `null` if it doesn't exist / isn't this user's. */
  async getChat(userId: string, sessionId: string): Promise<ChatRecord<TMessage> | null> {
    const doc = await this.getDoc(sessionId);
    if (!doc || doc.userId !== userId) return null;
    return this.toRecord(doc);
  }

  /** List a user's chats (summaries only), newest-updated first. Filters the index by `userId`. */
  async listChats(userId: string, opts: { limit?: number } = {}): Promise<ChatSummary[]> {
    const results = await withIndex(
      () => this.provision(),
      () =>
        this.index.query({
          filter: { userId: { $eq: userId } } as never,
          ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        }) as Promise<{ data?: ChatDoc<TMessage> }[] | null>,
      (r) => r === null,
    );
    const summaries = (results ?? [])
      .map((r) => (r.data ? this.toSummary(r.data) : undefined))
      .filter((x): x is ChatSummary => x !== undefined);
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return summaries;
  }

  /**
   * Fuzzily search a user's chats by what was said. `target` picks which side to match: `"user"`,
   * `"model"`, or `"both"` (default). Returns summaries with BM25 scores, most relevant first.
   */
  async searchChats(
    userId: string,
    query: string,
    opts: { limit?: number; minScore?: number; target?: "user" | "model" | "both" } = {},
  ): Promise<ChatSearchHit[]> {
    const target = opts.target ?? "both";
    const text =
      target === "user"
        ? [{ userMessages: { $smart: query } }]
        : target === "model"
          ? [{ modelMessages: { $smart: query } }]
          : [{ userMessages: { $smart: query } }, { modelMessages: { $smart: query } }];
    const results = await withIndex(
      () => this.provision(),
      () =>
        this.index.query({
          filter: { $and: [{ userId: { $eq: userId } }, { $or: text }] } as never,
          ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        }) as Promise<{ data?: ChatDoc<TMessage>; score: number }[] | null>,
      (r) => r === null,
    );
    const minScore = opts.minScore ?? 0;
    return (results ?? [])
      .filter((r) => r.data && r.score >= minScore)
      .map((r) => ({ ...this.toSummary(r.data as ChatDoc<TMessage>), score: r.score }));
  }

  /** Delete a chat (also removes it from the index). */
  async deleteChat(userId: string, sessionId: string): Promise<void> {
    const doc = await this.getDoc(sessionId);
    if (!doc || doc.userId !== userId) return;
    await this.redis.del(this.keyFor(sessionId));
  }

  /** Set/replace a chat's title. */
  async setTitle(userId: string, sessionId: string, title: string): Promise<void> {
    const existing = await this.getChat(userId, sessionId);
    if (!existing) return;
    await this.saveChat(userId, sessionId, existing.messages, {
      title,
      ...(existing.metadata !== undefined ? { metadata: existing.metadata } : {}),
    });
  }
}
