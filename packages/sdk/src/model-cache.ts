import { randomUUID } from "node:crypto";
import type { Redis } from "@upstash/redis";
import { RedisSearchIndex, type SearchIndexHandle } from "./search-index.js";
import { key, now } from "./utils.js";

export interface ModelCacheConfig {
  /** The Upstash Redis client. The search index is created and managed internally. */
  redis: Redis;
  /** Minimum relevance (BM25) score to count as a hit. Defaults to 1. */
  minScore?: number;
  /** Optional TTL (seconds) per entry. */
  ttlSeconds?: number;
  /** Key prefix + index name base; defaults to `agentkit:semcache`. */
  namespace?: string;
}

export interface ModelCacheHit {
  /** The cached response. */
  response: string;
  /** Relevance between the lookup prompt and the stored prompt. */
  score: number;
  /** The prompt that was originally cached. */
  prompt: string;
}

/**
 * A semantic cache for LLM responses backed by Upstash Redis Search. Instead of exact-matching
 * prompts, it reuses a cached response when a new prompt fuzzily matches (`$smart`, score >=
 * `minScore`) a previously seen one — collapsing close paraphrases and typos onto one model call.
 *
 * Pass only the `redis` client; the cache owns its index internally (exposed via {@link searchIndex}).
 * Scores are BM25 (unbounded), so tune `minScore` to your prompts.
 */
export class ModelCache {
  private store: RedisSearchIndex;
  private redis: Redis;
  private minScore: number;
  private ttlSeconds?: number;
  private namespace: string;

  constructor(config: ModelCacheConfig) {
    this.namespace = config.namespace ?? "agentkit:semcache";
    this.store = new RedisSearchIndex(config.redis, { namespace: this.namespace });
    this.redis = config.redis;
    this.minScore = config.minScore ?? 1;
    this.ttlSeconds = config.ttlSeconds;
  }

  /** The underlying Upstash Redis Search index handle. */
  get searchIndex(): SearchIndexHandle {
    return this.store.index;
  }

  private ttlKey(id: string): string {
    return key(this.namespace, "ttl", id);
  }

  /** Look up a fuzzily-similar cached response, or `null` on a miss. */
  async get(prompt: string, opts: { minScore?: number } = {}): Promise<ModelCacheHit | null> {
    const minScore = opts.minScore ?? this.minScore;
    const [hit] = await this.store.search(prompt, { topK: 1 });
    if (!hit || hit.score < minScore) return null;

    // Enforce TTL: if the marker key has expired, treat as a miss and evict.
    if (this.ttlSeconds !== undefined) {
      const alive = await this.redis.exists(this.ttlKey(hit.id));
      if (!alive) {
        await this.store.delete([hit.id]);
        return null;
      }
    }

    const md = (hit.metadata ?? {}) as { response?: string; prompt?: string };
    return {
      response: md.response ?? "",
      prompt: md.prompt ?? hit.content,
      score: hit.score,
    };
  }

  /** Cache `response` under `prompt`. */
  async set(prompt: string, response: string): Promise<void> {
    const id = randomUUID();
    await this.store.upsert([
      { id, content: prompt, metadata: { prompt, response, createdAt: now() } },
    ]);
    if (this.ttlSeconds !== undefined) {
      await this.redis.set(this.ttlKey(id), "1", { ex: this.ttlSeconds });
    }
  }

  /**
   * Wrap a generate function so calls are served from the cache when possible. On a miss the wrapped
   * function runs and its result is cached for next time.
   */
  wrap(generate: (prompt: string) => Promise<string>): (prompt: string) => Promise<string> {
    return async (prompt: string) => {
      const hit = await this.get(prompt);
      if (hit) return hit.response;
      const response = await generate(prompt);
      await this.set(prompt, response);
      return response;
    };
  }
}
