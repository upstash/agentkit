import { randomUUID } from "node:crypto";
import type { Redis } from "@upstash/redis";
import { RedisSearchIndex, type SearchIndexHandle } from "./search-index.js";
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
  /** Key prefix + index name base; defaults to `agentkit:memory`. */
  namespace?: string;
  /** Default relevance floor for {@link AgentMemory.recall} (BM25 score). */
  minScore?: number;
}

/**
 * Long-term agent memory with fuzzy recall, backed entirely by Upstash Redis Search. You pass only
 * the `redis` client; the memory creates and owns its search index internally and exposes the raw
 * handle via {@link AgentMemory.searchIndex} for advanced use (`describe`, `count`, `drop`, …).
 *
 * Memories are scoped (e.g. per user/agent) via an exact-match filter, and recalled with the `$smart`
 * operator (phrase / term / fuzzy / prefix matching).
 */
export class AgentMemory {
  private store: RedisSearchIndex;
  private minScore: number;

  constructor(config: AgentMemoryConfig) {
    this.store = new RedisSearchIndex(config.redis, {
      namespace: config.namespace ?? "agentkit:memory",
      filterFields: ["namespace"],
    });
    this.minScore = config.minScore ?? 0;
  }

  /** The underlying Upstash Redis Search index handle. */
  get searchIndex(): SearchIndexHandle {
    return this.store.index;
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
    const record: MemoryRecord = {
      id: opts.id ?? randomUUID(),
      text,
      metadata: opts.metadata,
      createdAt: now(),
    };
    await this.store.upsert([
      {
        id: `${namespace}:${record.id}`,
        content: text,
        filters: { namespace },
        metadata: { createdAt: record.createdAt, ...opts.metadata },
      },
    ]);
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
    const topK = opts.topK ?? 5;
    const hasQuery = Boolean(query && query.trim());
    // BM25 relevance only exists when there's a text query; a filter-only fetch scores 0 for all.
    const minScore = hasQuery ? (opts.minScore ?? this.minScore) : 0;

    const matched = await this.store.search(query, { topK, filters: { namespace } });
    // Fall back to "everything in the namespace" only when the text matched nothing — not when a
    // genuine match was filtered out by `minScore`.
    const hits =
      hasQuery && matched.length === 0
        ? await this.store.search(undefined, { topK, filters: { namespace } })
        : matched.filter((h) => h.score >= minScore);

    const idPrefix = `${namespace}:`;
    return hits.map((h) => {
      const md = (h.metadata ?? {}) as { createdAt?: number; [k: string]: unknown };
      const { createdAt, ...rest } = md;
      return {
        id: h.id.startsWith(idPrefix) ? h.id.slice(idPrefix.length) : h.id,
        text: h.content,
        createdAt: createdAt ?? 0,
        metadata: Object.keys(rest).length ? rest : undefined,
        score: h.score,
      };
    });
  }

  /** Delete a memory by id within its `namespace` (required, non-empty). */
  async forget(id: string, opts: { namespace: string }): Promise<void> {
    const { namespace } = opts;
    assertNamespace(namespace);
    await this.store.delete([`${namespace}:${id}`]);
  }
}
