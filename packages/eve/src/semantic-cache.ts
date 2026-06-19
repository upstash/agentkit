import type { SemanticCache } from "@upstash/agentkit-sdk";
import type { EveGenerateResult, EveGenerator } from "./types.js";

export interface WithSemanticCacheConfig {
  /** The AgentKit {@link SemanticCache} storing prompt -> response pairs. */
  cache: SemanticCache;
  /** Override the cache's default similarity floor for these lookups. */
  minScore?: number;
}

/**
 * Wrap an Eve-style generate/step function so semantically similar prompts are served from a
 * {@link SemanticCache} instead of re-invoking the model. On a cache miss the wrapped function runs
 * and its `text` is cached for next time. The returned function keeps Eve's `{ prompt }` -> `{ text }`
 * shape, so it is a drop-in for a call site that generates from a single prompt.
 *
 * ```ts
 * const cachedGenerate = withSemanticCache(
 *   (args) => eveModel.generate({ prompt: args.prompt }),
 *   { cache },
 * );
 * const { text } = await cachedGenerate({ prompt: "What is the capital of France?" });
 * ```
 */
export function withSemanticCache(
  generate: EveGenerator,
  config: WithSemanticCacheConfig,
): (args: { prompt: string }) => Promise<EveGenerateResult> {
  const { cache, minScore } = config;
  return async (args) => {
    const hit = await cache.get(args.prompt, minScore !== undefined ? { minScore } : {});
    if (hit) return { text: hit.response };
    const result = await generate(args);
    await cache.set(args.prompt, result.text);
    return result;
  };
}

/**
 * Thinner variant for call sites that model generation as `(prompt: string) => Promise<string>`.
 * Equivalent to the core SDK's {@link SemanticCache.wrap}, exposed here for symmetry.
 */
export function withSemanticCacheText(
  generate: (prompt: string) => Promise<string>,
  config: WithSemanticCacheConfig,
): (prompt: string) => Promise<string> {
  const wrapped = withSemanticCache(
    (args) => generate(args.prompt).then((text) => ({ text })),
    config,
  );
  return async (prompt) => (await wrapped({ prompt })).text;
}
