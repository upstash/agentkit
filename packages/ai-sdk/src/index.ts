// Model response cache as AI SDK language-model middleware
export { modelCacheMiddleware, cachedModel } from "./model-cache.js";
export type { ModelCacheMiddlewareConfig, CachedModelConfig } from "./model-cache.js";

// Rate limiting as AI SDK language-model middleware
export { rateLimitMiddleware, rateLimitedModel, RateLimitExceededError } from "./rate-limit.js";
export type { RateLimitMiddlewareConfig, RateLimitedModelConfig } from "./rate-limit.js";

// Tool-call caching (self-contained cached tool)
export { cachedTool } from "./tools.js";
export type { CachePrefix, CachedToolConfig } from "./tools.js";

// Long-term memory as tools (recall + save)
export { createMemoryTools } from "./memory.js";
export type { CreateMemoryToolsConfig } from "./memory.js";

// Schema-driven Redis Search tools (search / aggregate / count)
export { createSearchTools } from "./search-tools.js";
export type { CreateSearchToolsConfig } from "./search-tools.js";
