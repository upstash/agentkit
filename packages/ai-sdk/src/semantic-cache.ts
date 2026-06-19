import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import { Redis } from "@upstash/redis";
import { SemanticCache } from "@upstash/agentkit-sdk";

type WrapArgs = Parameters<typeof wrapLanguageModel>[0];
type LanguageModel = WrapArgs["model"];
type Prompt = Parameters<
  NonNullable<LanguageModelMiddleware["wrapGenerate"]>
>[0]["params"]["prompt"];

export interface SemanticCacheMiddlewareConfig {
  /** A pre-built {@link SemanticCache}. Built from `redis` when omitted. */
  cache?: SemanticCache;
  /** Upstash Redis client used to build a cache when `cache` is omitted. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /** Minimum relevance (BM25) score to count as a hit. */
  minScore?: number;
  /** Cache key namespace / index. Defaults to `agentkit:semcache`. */
  namespace?: string;
}

/** Flatten an AI SDK prompt (array of messages) into text for semantic matching. */
function promptToText(prompt: Prompt): string {
  const parts: string[] = [];
  for (const message of prompt) {
    const content = message.content;
    if (typeof content === "string") {
      parts.push(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
          parts.push(part.text);
        }
      }
    }
  }
  return parts.join("\n").trim();
}

function resolveCache(config: SemanticCacheMiddlewareConfig): SemanticCache {
  if (config.cache) return config.cache;
  return new SemanticCache({
    redis: config.redis ?? Redis.fromEnv(),
    ...(config.minScore !== undefined ? { minScore: config.minScore } : {}),
    ...(config.namespace !== undefined ? { namespace: config.namespace } : {}),
  });
}

/**
 * An [AI SDK language-model middleware](https://ai-sdk.dev/docs/ai-sdk-core/middleware#caching) that
 * serves generations from a semantic cache: when a prompt fuzzily matches a previously-seen one
 * (Upstash Redis Search `$smart`), the cached result is returned instead of calling the model.
 *
 * ```ts
 * import { wrapLanguageModel } from "ai";
 * const model = wrapLanguageModel({ model: baseModel, middleware: semanticCacheMiddleware({ redis }) });
 * ```
 */
export function semanticCacheMiddleware(
  config: SemanticCacheMiddlewareConfig = {},
): LanguageModelMiddleware {
  const cache = resolveCache(config);
  return {
    wrapGenerate: async ({ doGenerate, params }) => {
      const key = promptToText(params.prompt);
      if (key) {
        const hit = await cache.get(key);
        if (hit) return JSON.parse(hit.response) as Awaited<ReturnType<typeof doGenerate>>;
      }
      const result = await doGenerate();
      if (key) await cache.set(key, JSON.stringify(result));
      return result;
    },
  };
}

export interface SemanticCachedModelConfig extends SemanticCacheMiddlewareConfig {
  /** The language model to wrap. */
  model: LanguageModel;
}

/**
 * Wrap a language model so semantically-similar prompts are served from a semantic cache.
 *
 * ```ts
 * import { semanticCachedModel } from "@upstash/agentkit-ai-sdk";
 * import { generateText } from "ai";
 *
 * const model = semanticCachedModel({ model: openai("gpt-4o"), redis });
 * await generateText({ model, prompt: "..." });
 * ```
 */
export function semanticCachedModel(config: SemanticCachedModelConfig): LanguageModel {
  const { model, ...rest } = config;
  return wrapLanguageModel({ model, middleware: semanticCacheMiddleware(rest) });
}
