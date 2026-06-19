import type { SemanticCache } from "@upstash/agentkit-sdk";
import type { GenerateTextResultLike, PromptGenerator } from "./types.js";

export interface WithSemanticCacheConfig {
  /** The AgentKit {@link SemanticCache} that stores prompt -> response pairs. */
  cache: SemanticCache;
  /** Override the cache's default similarity floor for these lookups. */
  minScore?: number;
}

/**
 * Wrap an AI-SDK-style `generateText` function so semantically similar prompts are served from a
 * {@link SemanticCache} instead of re-invoking the model. On a cache miss the wrapped function runs
 * and its `text` is cached for next time.
 *
 * The returned function keeps the AI SDK's `{ prompt }` -> `{ text }` shape, so it is a drop-in for a
 * call site that uses `generateText({ prompt })`.
 *
 * ```ts
 * const cachedGenerate = withSemanticCache(
 *   (args) => generateText({ model, prompt: args.prompt }),
 *   { cache },
 * );
 * const { text } = await cachedGenerate({ prompt: "What is the capital of France?" });
 * ```
 */
export function withSemanticCache(
  generate: PromptGenerator,
  config: WithSemanticCacheConfig,
): (args: { prompt: string }) => Promise<GenerateTextResultLike> {
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
 * A thinner variant for call sites that model generation as `(prompt: string) => Promise<string>`.
 * Equivalent to the core SDK's {@link SemanticCache.wrap}, exposed here for symmetry with the AI SDK
 * adapter surface.
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
