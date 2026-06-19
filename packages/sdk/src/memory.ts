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
      filterFields: ["scope"],
    });
    this.minScore = config.minScore ?? 0;
  }

  /** The underlying Upstash Redis Search index handle. */
  get searchIndex(): SearchIndexHandle {
    return this.store.index;
  }

  /** Store a memory under `scope`. Returns the persisted record. */
  async add(
    text: string,
    opts: { id?: string; metadata?: Record<string, unknown>; scope?: string } = {},
  ): Promise<MemoryRecord> {
    const record: MemoryRecord = {
      id: opts.id ?? randomUUID(),
      text,
      metadata: opts.metadata,
      createdAt: now(),
    };
    await this.store.upsert([
      {
        id: record.id,
        content: text,
        filters: { scope: opts.scope ?? "default" },
        metadata: { createdAt: record.createdAt, ...opts.metadata },
      },
    ]);
    return record;
  }

  /** Fuzzily recall the memories most relevant to `query` within `scope`. */
  async recall(
    query: string,
    opts: { topK?: number; scope?: string; minScore?: number } = {},
  ): Promise<RecalledMemory[]> {
    const minScore = opts.minScore ?? this.minScore;
    const hits = await this.store.search(query, {
      topK: opts.topK ?? 5,
      filters: { scope: opts.scope ?? "default" },
    });
    return hits
      .filter((h) => h.score >= minScore)
      .map((h) => {
        const md = (h.metadata ?? {}) as { createdAt?: number; [k: string]: unknown };
        const { createdAt, ...rest } = md;
        return {
          id: h.id,
          text: h.content,
          createdAt: createdAt ?? 0,
          metadata: Object.keys(rest).length ? rest : undefined,
          score: h.score,
        };
      });
  }

  /** Delete a memory by id. */
  async forget(id: string): Promise<void> {
    await this.store.delete([id]);
  }
}
