import { randomUUID } from "node:crypto";
import type { Redis } from "@upstash/redis";
import { RedisSearchIndex, type SearchIndexHandle } from "./search-index.js";
import { now } from "./utils.js";

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

  /** Store a memory under `namespace`. Returns the persisted record. Key: `agentkit:memory:<namespace>:<id>`. */
  async add(
    text: string,
    opts: { id?: string; metadata?: Record<string, unknown>; namespace?: string } = {},
  ): Promise<MemoryRecord> {
    const namespace = opts.namespace ?? "default";
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
   * empty string) to return any memories in the namespace, unfiltered by relevance (the `minScore`
   * floor only applies when there's a `query`).
   */
  async recall(
    query?: string,
    opts: { topK?: number; namespace?: string; minScore?: number } = {},
  ): Promise<RecalledMemory[]> {
    const namespace = opts.namespace ?? "default";
    // BM25 relevance only exists when there's a text query; a filter-only fetch scores 0 for all.
    const minScore = query && query.trim() ? (opts.minScore ?? this.minScore) : 0;
    const hits = await this.store.search(query, {
      topK: opts.topK ?? 5,
      filters: { namespace },
    });
    const idPrefix = `${namespace}:`;
    return hits
      .filter((h) => h.score >= minScore)
      .map((h) => {
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

  /** Delete a memory by id within its `namespace`. */
  async forget(id: string, opts: { namespace?: string } = {}): Promise<void> {
    await this.store.delete([`${opts.namespace ?? "default"}:${id}`]);
  }
}
