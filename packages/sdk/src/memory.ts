import { randomUUID } from "node:crypto";
import { s } from "@upstash/redis";
import type { InferFilterFromSchema, Redis, SearchIndex } from "@upstash/redis";
import { now } from "./utils.js";

/**
 * Reject an empty/missing namespace. The namespace is the only tenant boundary for memory, so a blank
 * one would silently collapse every caller into one shared bucket and leak memories across users.
 */
function assertNamespace(namespace: string | undefined): asserts namespace is string {
  if (namespace === undefined || namespace === "") {
    throw new Error("AgentMemory: `namespace` is required and must be a non-empty string.");
  }
}

export interface MemoryRecord {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export interface RecalledMemory extends MemoryRecord {
  score: number;
}

export interface AgentMemoryConfig {
  /** The Upstash Redis client. The search index is created and managed internally. */
  redis: Redis;
  /** Base key prefix + index name base; defaults to `agentkit:memory`. */
  prefix?: string;
  /** Default relevance floor for {@link AgentMemory.recall} (BM25 score). */
  minScore?: number;
}

/** Where the non-indexed memory metadata (incl. `createdAt`) rides along in each JSON document. */
const META_FIELD = "__meta";

/** One JSON doc per memory: `text` is fuzzy-searchable, `namespace` is an exact-match tenant filter. */
const MemorySchema = s.object({
  text: s.string(),
  namespace: s.string().noTokenize(),
});

/** The metadata blob stored under {@link META_FIELD} (the per-call metadata plus `createdAt`). */
type StoredMeta = { createdAt?: number; [k: string]: unknown };

/**
 * Long-term agent memory with fuzzy recall, backed entirely by Upstash Redis Search. You pass only
 * the `redis` client; the memory creates and owns its search index internally and exposes the typed
 * handle via {@link AgentMemory.searchIndex} for advanced use (`describe`, `count`, `drop`, …).
 *
 * Each memory is one JSON doc at `agentkit:memory:<namespace>:<id>`. Memories are scoped per
 * user/agent via the exact-match `namespace` filter, and recalled with the `$smart` operator
 * (phrase / term / fuzzy / prefix matching).
 */
export class AgentMemory {
  private redis: Redis;
  private indexName: string;
  private keyPrefix: string;
  private index: SearchIndex<typeof MemorySchema>;
  private minScore: number;
  private created?: Promise<void>;

  constructor(config: AgentMemoryConfig) {
    this.redis = config.redis;
    const prefix = config.prefix ?? "agentkit:memory";
    // Index names must be identifier-safe; the key prefix keeps the human-readable base prefix.
    this.indexName = prefix.replace(/[^a-zA-Z0-9_]/g, "_");
    this.keyPrefix = `${prefix}:`;
    this.index = this.redis.search.index({ name: this.indexName, schema: MemorySchema });
    this.minScore = config.minScore ?? 0;
  }

  /** The underlying (typed) Upstash Redis Search index handle. */
  get searchIndex() {
    return this.index;
  }

  private keyFor(namespace: string, id: string): string {
    return `${this.keyPrefix}${namespace}:${id}`;
  }

  /** Create the index once (idempotent — "already exists" is treated as success). */
  private ensure(): Promise<void> {
    if (!this.created) {
      this.created = this.redis.search
        .createIndex({
          name: this.indexName,
          dataType: "json",
          prefix: this.keyPrefix,
          schema: MemorySchema,
        })
        .then(() => undefined)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (!/already exists/i.test(msg)) throw err;
        });
    }
    return this.created;
  }

  /**
   * Store a memory under `namespace` (required, non-empty — make it unique per user). Returns the
   * persisted record. Key: `agentkit:memory:<namespace>:<id>`.
   */
  async add(
    text: string,
    opts: { namespace: string; id?: string; metadata?: Record<string, unknown> },
  ): Promise<MemoryRecord> {
    const { namespace } = opts;
    assertNamespace(namespace);
    await this.ensure();
    const record: MemoryRecord = {
      id: opts.id ?? randomUUID(),
      text,
      metadata: opts.metadata,
      createdAt: now(),
    };
    await this.redis.json.set(this.keyFor(namespace, record.id), "$", {
      text,
      namespace,
      [META_FIELD]: { createdAt: record.createdAt, ...opts.metadata },
    });
    return record;
  }

  /**
   * Fuzzily recall the memories most relevant to `query` within `namespace`. Omit `query` (or pass an
   * empty string) to return any memories in the namespace, unfiltered by relevance. When a `query` is
   * given but the text matches **nothing at all**, it falls back to that same "everything in the
   * namespace" fetch — so recall isn't empty just because the fuzzy text didn't match (e.g. a model
   * passing "everything"). `minScore` still filters genuine-but-weak matches (no fallback then).
   */
  async recall(
    query: string | undefined,
    opts: { namespace: string; topK?: number; minScore?: number },
  ): Promise<RecalledMemory[]> {
    const { namespace } = opts;
    assertNamespace(namespace);
    await this.ensure();
    const topK = opts.topK ?? 5;
    const hasQuery = Boolean(query && query.trim());
    // BM25 relevance only exists when there's a text query; a filter-only fetch scores 0 for all.
    const minScore = hasQuery ? (opts.minScore ?? this.minScore) : 0;

    const matched = await this.query(namespace, hasQuery ? query : undefined, topK);
    // Fall back to "everything in the namespace" only when the text matched nothing — not when a
    // genuine match was filtered out by `minScore`.
    const hits =
      hasQuery && matched.length === 0
        ? await this.query(namespace, undefined, topK)
        : matched.filter((h) => h.score >= minScore);

    const idPrefix = this.keyFor(namespace, "");
    return hits.map((h) => {
      const { createdAt, ...rest } = h.meta;
      return {
        id: h.key.startsWith(idPrefix) ? h.key.slice(idPrefix.length) : h.key,
        text: h.text,
        createdAt: createdAt ?? 0,
        metadata: Object.keys(rest).length ? rest : undefined,
        score: h.score,
      };
    });
  }

  /** Run a `namespace`-scoped query (optionally fuzzy on `text`) and return normalized rows. */
  private async query(
    namespace: string,
    query: string | undefined,
    topK: number,
  ): Promise<{ key: string; text: string; meta: StoredMeta; score: number }[]> {
    const filter: Record<string, unknown> = { namespace: { $eq: namespace } };
    if (query && query.trim()) filter.text = { $smart: query };
    // `query` returns the indexed fields plus the unindexed `__meta` we read here, so cast the result.
    const rows = (await this.index.query({
      filter: filter as InferFilterFromSchema<typeof MemorySchema>,
      limit: topK,
    })) as unknown as
      | { key: string; score: number; data?: { text?: string; [META_FIELD]?: StoredMeta } }[]
      | null;
    return (rows ?? []).map((r) => ({
      key: r.key,
      text: typeof r.data?.text === "string" ? r.data.text : "",
      meta: r.data?.[META_FIELD] ?? {},
      score: r.score,
    }));
  }

  /** Delete a memory by id within its `namespace` (required, non-empty). */
  async forget(id: string, opts: { namespace: string }): Promise<void> {
    const { namespace } = opts;
    assertNamespace(namespace);
    await this.redis.del(this.keyFor(namespace, id));
  }
}
