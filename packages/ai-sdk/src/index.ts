// Rate limiting — re-exported from the core adapter. Call `.limit(identifier)` yourself before
// `generateText` (no model wrapper). Keys are `agentkit:rateLimit:<identifier>`.
export { createRateLimit } from "@upstash/agentkit-sdk";
export type { RateLimitConfig } from "@upstash/agentkit-sdk";

// Tool-call caching (self-contained cached tools)
export { cachedTool, cachedTools } from "./tools.js";
export type {
  CacheNamespace,
  CacheOptions,
  CachedToolConfig,
  CachedToolsOptions,
} from "./tools.js";

// Long-term memory as tools (recall + save)
export { createMemoryTools } from "./memory.js";
export type { CreateMemoryToolsConfig, MemoryNamespace } from "./memory.js";

// Schema-driven Redis Search tools (search / aggregate / count)
export { createSearchTools } from "./search-tools.js";
export type { CreateSearchToolsConfig } from "./search-tools.js";
