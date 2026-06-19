import { randomUUID } from "node:crypto";
import type { RedisLike, SearchStore } from "./types.js";
import { key, now } from "./utils.js";

export interface SemanticCacheConfig {
  search: SearchStore;
  /** Optional Redis client used to enforce per-entry TTL. */
  redis?: RedisLike;
  /** Minimum relevance score to count as a hit. Defaults to 0.9. */
  minScore?: number;
  /** Optional TTL (seconds) per entry; only enforced when `redis` is set. */
  ttlSeconds?: number;
  /** Redis key prefix for TTL markers; defaults to `agentkit:semcache`. */
  namespace?: string;
}

export interface SemanticCacheHit {
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
 * Note: fuzzy text matching is weaker than embedding similarity — it catches typos and shared
 * wording, not deep paraphrases with disjoint vocabulary. Tune `minScore` to your data.
 */
export class SemanticCache {
  private search: SearchStore;
  private redis?: RedisLike;
  private minScore: number;
  private ttlSeconds?: number;
  private namespace: string;

  constructor(config: SemanticCacheConfig) {
    this.search = config.search;
    this.redis = config.redis;
    this.minScore = config.minScore ?? 0.9;
    this.ttlSeconds = config.ttlSeconds;
    this.namespace = config.namespace ?? "agentkit:semcache";
  }

  private ttlKey(id: string): string {
    return key(this.namespace, "ttl", id);
  }

  /** Look up a fuzzily-similar cached response, or `null` on a miss. */
  async get(prompt: string, opts: { minScore?: number } = {}): Promise<SemanticCacheHit | null> {
    const minScore = opts.minScore ?? this.minScore;
    const [hit] = await this.search.search({ query: prompt, topK: 1 });
    if (!hit || hit.score < minScore) return null;

    // Enforce TTL: if the marker key has expired, treat as a miss and evict.
    if (this.redis && this.ttlSeconds !== undefined) {
      const alive = await this.redis.exists(this.ttlKey(hit.id));
      if (!alive) {
        await this.search.delete([hit.id]);
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
    await this.search.upsert([
      { id, content: prompt, metadata: { prompt, response, createdAt: now() } },
    ]);
    if (this.redis && this.ttlSeconds !== undefined) {
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
