import { randomUUID } from "node:crypto";
import type { Embedder, RedisLike, VectorStore } from "./types.js";
import { key, now, toQueryPayload, toVectorPayload } from "./utils.js";

export interface SemanticCacheConfig {
  vector: VectorStore;
  /** Optional Redis client used to enforce per-entry TTL. */
  redis?: RedisLike;
  embedder?: Embedder;
  /** Vector namespace for cached prompts; defaults to `agentkit:semcache`. */
  namespace?: string;
  /** Minimum cosine similarity to count as a hit. Defaults to 0.9. */
  minScore?: number;
  /** Optional TTL (seconds) per entry; only enforced when `redis` is set. */
  ttlSeconds?: number;
}

export interface SemanticCacheHit {
  /** The cached response. */
  response: string;
  /** Similarity between the lookup prompt and the stored prompt. */
  score: number;
  /** The prompt that was originally cached. */
  prompt: string;
}

/**
 * A semantic cache for LLM responses: instead of exact-matching prompts, it reuses a cached response
 * when a new prompt is semantically similar (cosine >= `minScore`) to a previously seen one. This
 * collapses paraphrases ("What's the capital of France?" vs "France's capital?") onto one model call.
 */
export class SemanticCache {
  private vector: VectorStore;
  private redis?: RedisLike;
  private embedder?: Embedder;
  private namespace: string;
  private minScore: number;
  private ttlSeconds?: number;

  constructor(config: SemanticCacheConfig) {
    this.vector = config.vector;
    this.redis = config.redis;
    this.embedder = config.embedder;
    this.namespace = config.namespace ?? "agentkit:semcache";
    this.minScore = config.minScore ?? 0.9;
    this.ttlSeconds = config.ttlSeconds;
  }

  private ttlKey(id: string): string {
    return key(this.namespace, "ttl", id);
  }

  /** Look up a semantically similar cached response, or `null` on a miss. */
  async get(prompt: string, opts: { minScore?: number } = {}): Promise<SemanticCacheHit | null> {
    const minScore = opts.minScore ?? this.minScore;
    const payload = await toQueryPayload(prompt, this.embedder);
    const [match] = await this.vector.query({
      ...payload,
      topK: 1,
      namespace: this.namespace,
      includeMetadata: true,
    });
    if (!match || match.score < minScore) return null;

    // Enforce TTL: if the marker key has expired, treat as a miss and evict.
    if (this.redis && this.ttlSeconds !== undefined) {
      const alive = await this.redis.exists(this.ttlKey(match.id));
      if (!alive) {
        await this.vector.delete([match.id], { namespace: this.namespace });
        return null;
      }
    }

    const md = (match.metadata ?? {}) as { response?: string; prompt?: string };
    return {
      response: md.response ?? "",
      prompt: md.prompt ?? "",
      score: match.score,
    };
  }

  /** Cache `response` under `prompt`. */
  async set(prompt: string, response: string): Promise<void> {
    const id = randomUUID();
    const payload = await toVectorPayload(prompt, this.embedder);
    await this.vector.upsert(
      [{ id, ...payload, metadata: { prompt, response, createdAt: now() } }],
      { namespace: this.namespace },
    );
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
