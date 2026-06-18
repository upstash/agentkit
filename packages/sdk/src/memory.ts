import { randomUUID } from "node:crypto";
import type { Embedder, RedisLike, VectorStore } from "./types.js";
import { key, now, toQueryPayload, toVectorPayload } from "./utils.js";

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
  vector: VectorStore;
  /** Optional Redis client; required only for {@link AgentMemory.list}. */
  redis?: RedisLike;
  /** Inject to embed text yourself; omit to use the vector store's built-in embedding. */
  embedder?: Embedder;
  /** Redis key prefix for the id registry; defaults to `agentkit:memory`. */
  namespace?: string;
  /** Default similarity floor for {@link AgentMemory.recall}. */
  minScore?: number;
}

/**
 * Long-term agent memory with semantic recall. Each memory is embedded and stored in a vector index,
 * namespaced by `scope` (e.g. a user id or agent id) so memories stay isolated per subject. When a
 * Redis client is supplied an id registry is maintained too, enabling exhaustive `list()`.
 */
export class AgentMemory {
  private vector: VectorStore;
  private redis?: RedisLike;
  private embedder?: Embedder;
  private namespace: string;
  private minScore: number;

  constructor(config: AgentMemoryConfig) {
    this.vector = config.vector;
    this.redis = config.redis;
    this.embedder = config.embedder;
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
    const payload = await toVectorPayload(text, this.embedder);
    await this.vector.upsert(
      [
        {
          id: record.id,
          ...payload,
          metadata: { text, createdAt: record.createdAt, ...opts.metadata },
        },
      ],
      { namespace: scope },
    );
    if (this.redis) {
      await this.redis.rpush(this.registryKey(scope), record.id);
    }
    return record;
  }

  /** Semantically recall the memories most relevant to `query` within `scope`. */
  async recall(
    query: string,
    opts: { topK?: number; scope?: string; minScore?: number; filter?: string } = {},
  ): Promise<RecalledMemory[]> {
    const scope = opts.scope ?? "default";
    const minScore = opts.minScore ?? this.minScore;
    const payload = await toQueryPayload(query, this.embedder);
    const matches = await this.vector.query({
      ...payload,
      topK: opts.topK ?? 5,
      namespace: scope,
      filter: opts.filter,
      includeMetadata: true,
    });
    return matches
      .filter((m) => m.score >= minScore)
      .map((m) => {
        const md = m.metadata ?? {};
        const { text, createdAt, ...rest } = md as {
          text?: string;
          createdAt?: number;
          [k: string]: unknown;
        };
        return {
          id: m.id,
          text: text ?? "",
          createdAt: createdAt ?? 0,
          metadata: Object.keys(rest).length ? rest : undefined,
          score: m.score,
        };
      });
  }

  /** Delete a memory by id from `scope`. */
  async forget(id: string, opts: { scope?: string } = {}): Promise<void> {
    const scope = opts.scope ?? "default";
    await this.vector.delete([id], { namespace: scope });
    if (this.redis) {
      // Rebuild the registry without the removed id.
      const ids = await this.redis.lrange<string>(this.registryKey(scope), 0, -1);
      await this.redis.del(this.registryKey(scope));
      const remaining = ids.filter((x) => x !== id);
      if (remaining.length) await this.redis.rpush(this.registryKey(scope), ...remaining);
    }
  }

  /**
   * List the ids of all memories in `scope`. Requires a Redis client (the vector index alone cannot
   * enumerate). Throws if no Redis client was configured.
   */
  async listIds(scope = "default"): Promise<string[]> {
    if (!this.redis) {
      throw new Error("AgentMemory.listIds requires a `redis` client in the config.");
    }
    return this.redis.lrange<string>(this.registryKey(scope), 0, -1);
  }
}
