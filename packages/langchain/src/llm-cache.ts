import {
  SemanticCache,
  type SemanticCacheConfig,
  type SearchIndexHandle,
} from "@upstash/agentkit-sdk";
import type { CacheLike, GenerationLike } from "./types.js";

/**
 * A LangChain-style LLM cache backed by the AgentKit {@link SemanticCache} (Upstash Redis Search).
 *
 * It mirrors LangChain's `BaseCache` surface (`lookup` / `update`) so it can be passed as the `cache`
 * option to a chat model. Unlike LangChain's default exact-match cache, lookups are *fuzzy*: a prompt
 * that is sufficiently similar (`$smart` score >= `minScore`) to a previously cached one returns the
 * stored generation, collapsing close paraphrases and typos onto a single model call. The `llmKey`
 * argument LangChain passes (a hash of the model config) is accepted for interface compatibility but
 * ignored — matching is purely on prompt text.
 *
 * @example
 * ```ts
 * const cache = new SemanticLLMCache({ redis, minScore: 0.9 });
 * const hit = await cache.lookup("What is the capital of France?");
 * if (!hit) await cache.update("What is the capital of France?", "llm-key", [{ text: "Paris" }]);
 * ```
 */
export class SemanticLLMCache implements CacheLike {
  private cache: SemanticCache;

  constructor(config: SemanticCacheConfig) {
    this.cache = new SemanticCache(config);
  }

  /** The underlying Upstash Redis Search index handle (e.g. to `waitIndexing` in tests). */
  get searchIndex(): SearchIndexHandle {
    return this.cache.searchIndex;
  }

  /**
   * Look up a cached generation for `prompt`. Returns a single-element generation array on a fuzzy
   * hit (LangChain expects `Generation[] | null`), or `null` on a miss.
   */
  async lookup(prompt: string, _llmKey?: string): Promise<GenerationLike[] | null> {
    const hit = await this.cache.get(prompt);
    if (!hit) return null;
    return [{ text: hit.response }];
  }

  /**
   * Cache `value` under `prompt`. Only the first generation's text is stored (the cache operates on a
   * single canonical response per prompt).
   */
  async update(prompt: string, _llmKey: string, value: GenerationLike[]): Promise<void> {
    const first = value[0];
    if (!first) return;
    await this.cache.set(prompt, first.text);
  }
}
