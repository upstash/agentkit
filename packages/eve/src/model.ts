/**
 * Model wrappers for an Eve agent's `model` (see https://eve.dev/docs/agent-config), re-exported from
 * the AI SDK adapter — Eve uses Vercel AI SDK language models, so the same middleware applies. Wrap
 * your model with these in your agent config to add semantic caching and rate limiting.
 *
 * ```ts
 * // agent/index.ts
 * import { openai } from "@ai-sdk/openai";
 * import { cachedModel, rateLimitedModel } from "@upstash/agentkit-eve/model";
 * import { redis } from "./redis";
 *
 * export const model = rateLimitedModel({
 *   model: cachedModel({ model: openai("gpt-5.4-mini"), redis }),
 *   redis,
 *   limit: 20,
 *   window: "1 m",
 * });
 * ```
 */
export {
  modelCacheMiddleware,
  cachedModel,
  rateLimitMiddleware,
  rateLimitedModel,
  RateLimitExceededError,
} from "@upstash/agentkit-ai-sdk";
export type {
  ModelCacheMiddlewareConfig,
  CachedModelConfig,
  RateLimitMiddlewareConfig,
  RateLimitedModelConfig,
} from "@upstash/agentkit-ai-sdk";
