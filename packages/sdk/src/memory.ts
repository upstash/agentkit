import { randomUUID } from "node:crypto";
import { s } from "@upstash/redis";
import type { InferFilterFromSchema, Redis } from "@upstash/redis";
import { ReactiveSearchIndex } from "./reactive-index.js";
import { now } from "./utils.js";

/**
 * Reject an empty/missing userId. The userId is the only tenant boundary for memory, so a blank one
 * would silently collapse every caller into one shared bucket and leak memories across users.
 */
function assertUserId(userId: string | undefined): asserts userId is string {
  if (userId === undefined || userId === "") {
    throw new Error("AgentMemory: `userId` is required and must be a non-empty string.");
  }
}

export interface MemoryRecord {
  id: string;
  text: string;
  createdAt: number;
}

export interface RecalledMemory extends MemoryRecord {
  score: number;
}

export interface AgentMemoryConfig {
  /** The Upstash Redis client. The search index is created and managed internally. */
  redis: Redis;
  /** Base key prefix for stored memories. Defaults to `agentkit:memory`. */
  prefix?: string;
  /** Redis Search index name. Defaults to the (identifier-safe) `prefix`. */
  indexName?: string;
  /** Default relevance floor for {@link AgentMemory.recall} (BM25 score). */
  minScore?: number;
}

/** One JSON doc per memory: `text` is fuzzy-searchable, `userId` is an exact-match tenant filter. */
const MemorySchema = s.object({
  text: s.string(),
  userId: s.string().noTokenize(),
});

/**
 * Long-term agent memory with fuzzy recall, backed entirely by Upstash Redis Search. You pass only
 * the `redis` client; the memory creates and owns its search index internally (reactively, on the
 * first recall) and exposes the handle via {@link AgentMemory.searchIndex} for advanced use.
 *
 * Each memory is one JSON doc at `<prefix>:<userId>:<id>`. Memories are scoped per user via the
 * exact-match `userId` filter, and recalled with the `$smart` operator (phrase/term/fuzzy/prefix).
 */
export class AgentMemory {
  private redis: Redis;
  private keyPrefix: string;
  private index: ReactiveSearchIndex<typeof MemorySchema>;
  private minScore: number;

  constructor(config: AgentMemoryConfig) {
    this.redis = config.redis;
    const prefix = config.prefix ?? "agentkit:memory";
    // Index names must be identifier-safe; the key prefix keeps the human-readable base prefix.
    const indexName = config.indexName ?? prefix.replace(/[^a-zA-Z0-9_]/g, "_");
    this.keyPrefix = `${prefix}:`;
    this.index = new ReactiveSearchIndex({
      redis: this.redis,
      indexName,
      prefix: this.keyPrefix,
      schema: MemorySchema,
    });
    this.minScore = config.minScore ?? 0;
  }

  /** The underlying (reactive) Upstash Redis Search index handle. */
  get searchIndex() {
    return this.index;
  }

  private keyFor(userId: string, id: string): string {
    return `${this.keyPrefix}${userId}:${id}`;
  }

  /**
   * Store a memory for `userId` (required, non-empty — unique per user). Returns the persisted record.
   * Key: `<prefix>:<userId>:<id>`. Writes go straight to Redis; the index is created on first recall.
   */
  async add(params: { text: string; userId: string; id?: string }): Promise<MemoryRecord> {
    const { text, userId } = params;
    assertUserId(userId);
    const record: MemoryRecord = { id: params.id ?? randomUUID(), text, createdAt: now() };
    // `createdAt` is stored but not in the schema, so it rides along unindexed.
    await this.redis.json.set(this.keyFor(userId, record.id), "$", {
      text,
      userId,
      createdAt: record.createdAt,
    });
    return record;
  }

  /**
   * Fuzzily recall the memories most relevant to `query` for `userId`. Omit `query` (or pass an empty
   * string) to return any memories for the user, unfiltered by relevance. When a `query` is given but
   * the text matches **nothing at all**, it falls back to that same "everything for the user" fetch —
   * so recall isn't empty just because the fuzzy text didn't match (e.g. a model passing "everything").
   * `minScore` still filters genuine-but-weak matches (no fallback then).
   */
  async recall(params: {
    userId: string;
    query?: string;
    topK?: number;
    minScore?: number;
  }): Promise<RecalledMemory[]> {
    const { userId, query } = params;
    assertUserId(userId);
    const topK = params.topK ?? 5;
    const hasQuery = Boolean(query && query.trim());
    // BM25 relevance only exists when there's a text query; a filter-only fetch scores 0 for all.
    const minScore = hasQuery ? (params.minScore ?? this.minScore) : 0;

    const matched = await this.query(userId, hasQuery ? query : undefined, topK);
    // Fall back to "everything for the user" only when the text matched nothing — not when a genuine
    // match was filtered out by `minScore`.
    const hits =
      hasQuery && matched.length === 0
        ? await this.query(userId, undefined, topK)
        : matched.filter((h) => h.score >= minScore);

    const idPrefix = this.keyFor(userId, "");
    return hits.map((h) => ({
      id: h.key.startsWith(idPrefix) ? h.key.slice(idPrefix.length) : h.key,
      text: h.text,
      createdAt: h.createdAt,
      score: h.score,
    }));
  }

  /** Run a `userId`-scoped query (optionally fuzzy on `text`) and return normalized rows. */
  private async query(
    userId: string,
    query: string | undefined,
    topK: number,
  ): Promise<{ key: string; text: string; createdAt: number; score: number }[]> {
    const filter: Record<string, unknown> = { userId: { $eq: userId } };
    if (query && query.trim()) filter.text = { $smart: query };
    // `query` returns the indexed fields plus the unindexed `createdAt`, so cast the result.
    const rows = (await this.index.query({
      filter: filter as InferFilterFromSchema<typeof MemorySchema>,
      limit: topK,
    })) as unknown as {
      key: string;
      score: number;
      data?: { text?: string; createdAt?: number };
    }[];
    return rows.map((r) => ({
      key: r.key,
      text: typeof r.data?.text === "string" ? r.data.text : "",
      createdAt: typeof r.data?.createdAt === "number" ? r.data.createdAt : 0,
      score: r.score,
    }));
  }

  /** Delete a memory by id for `userId` (required, non-empty). */
  async forget(id: string, opts: { userId: string }): Promise<void> {
    const { userId } = opts;
    assertUserId(userId);
    await this.redis.del(this.keyFor(userId, id));
  }
}
