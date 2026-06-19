// Semantic caching as AI SDK language-model middleware
export { semanticCacheMiddleware, semanticCachedModel } from "./semantic-cache.js";
export type { SemanticCacheMiddlewareConfig, SemanticCachedModelConfig } from "./semantic-cache.js";

// Rate limiting as AI SDK language-model middleware
export { rateLimitMiddleware, rateLimitedModel, RateLimitExceededError } from "./rate-limit.js";
export type { RateLimitMiddlewareConfig, RateLimitedModelConfig } from "./rate-limit.js";

// Tool-call caching (map in -> map out, keys preserved)
export { cacheTools } from "./tools.js";
export type { CacheToolsConfig } from "./tools.js";

// Long-term memory as tools (recall + save)
export { createMemoryTools } from "./memory.js";
export type { CreateMemoryToolsConfig } from "./memory.js";

// Schema-driven Redis Search tools (search / aggregate / count)
export { createSearchTools } from "./search-tools.js";
export type { CreateSearchToolsConfig } from "./search-tools.js";
