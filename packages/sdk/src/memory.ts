import { randomUUID } from "node:crypto";
import type { RedisLike, SearchStore } from "./types.js";
import { key, now } from "./utils.js";

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
  search: SearchStore;
  /** Optional Redis client; required only for {@link AgentMemory.listIds}. */
  redis?: RedisLike;
  /** Redis key prefix for the id registry; defaults to `agentkit:memory`. */
  namespace?: string;
  /** Default relevance floor for {@link AgentMemory.recall}. */
  minScore?: number;
}

/**
 * Long-term agent memory with fuzzy recall over Upstash Redis Search. Each memory is stored as a
 * searchable document scoped by `scope` (e.g. a user id or agent id) via an exact-match filter, so
 * memories stay isolated per subject. Recall uses the `$smart` operator under the hood. When a Redis
 * client is supplied an id registry is maintained too, enabling exhaustive `listIds`.
 */
export class AgentMemory {
  private search: SearchStore;
  private redis?: RedisLike;
  private namespace: string;
  private minScore: number;

  constructor(config: AgentMemoryConfig) {
    this.search = config.search;
    this.redis = config.redis;
    this.namespace = config.namespace ?? "agentkit:memory";
    this.minScore = config.minScore ?? 0;
  }

  private registryKey(scope: string): string {
    return key(this.namespace, scope, "ids");
  }

  /** Store a memory under `scope`. Returns the persisted record. */
  async add(
    text: string,
    opts: { id?: string; metadata?: Record<string, unknown>; scope?: string } = {},
  ): Promise<MemoryRecord> {
    const scope = opts.scope ?? "default";
    const record: MemoryRecord = {
      id: opts.id ?? randomUUID(),
      text,
      metadata: opts.metadata,
      createdAt: now(),
    };
    await this.search.upsert([
      {
        id: record.id,
        content: text,
        metadata: { text, createdAt: record.createdAt, ...opts.metadata },
        filters: { scope },
      },
    ]);
    if (this.redis) {
      await this.redis.rpush(this.registryKey(scope), record.id);
    }
    return record;
  }

  /** Fuzzily recall the memories most relevant to `query` within `scope`. */
  async recall(
    query: string,
    opts: { topK?: number; scope?: string; minScore?: number } = {},
  ): Promise<RecalledMemory[]> {
    const scope = opts.scope ?? "default";
    const minScore = opts.minScore ?? this.minScore;
    const hits = await this.search.search({
      query,
      topK: opts.topK ?? 5,
      filters: { scope },
    });
    return hits
      .filter((h) => h.score >= minScore)
      .map((h) => {
        const md = (h.metadata ?? {}) as {
          text?: string;
          createdAt?: number;
          [k: string]: unknown;
        };
        const { text, createdAt, ...rest } = md;
        return {
          id: h.id,
          text: text ?? h.content,
          createdAt: createdAt ?? 0,
          metadata: Object.keys(rest).length ? rest : undefined,
          score: h.score,
        };
      });
  }

  /** Delete a memory by id from `scope`. */
  async forget(id: string, opts: { scope?: string } = {}): Promise<void> {
    const scope = opts.scope ?? "default";
    await this.search.delete([id]);
    if (this.redis) {
      // Rebuild the registry without the removed id.
      const ids = await this.redis.lrange<string>(this.registryKey(scope), 0, -1);
      await this.redis.del(this.registryKey(scope));
      const remaining = ids.filter((x) => x !== id);
      if (remaining.length) await this.redis.rpush(this.registryKey(scope), ...remaining);
    }
  }

  /**
   * List the ids of all memories in `scope`. Requires a Redis client (the search index alone cannot
   * enumerate). Throws if no Redis client was configured.
   */
  async listIds(scope = "default"): Promise<string[]> {
    if (!this.redis) {
      throw new Error("AgentMemory.listIds requires a `redis` client in the config.");
    }
    return this.redis.lrange<string>(this.registryKey(scope), 0, -1);
  }
}
