// Rate limiting — re-exported from the core adapter. Call `.limit(identifier)` yourself before
// `generateText` (no model wrapper). Keys are `agentkit:rateLimit:<identifier>`.
// `Ratelimit` (for custom limiters like `Ratelimit.fixedWindow(...)`) and the `Duration` type are
// re-exported too, so users never import from (or install) `@upstash/ratelimit` directly.
export { createRateLimit, Ratelimit } from "@upstash/agentkit-sdk";
export type { RateLimitConfig, Duration } from "@upstash/agentkit-sdk";

// Tool-call caching (self-contained cached tools)
export { cachedTools } from "./tools.js";
export type { CacheUserId, CachedToolsOptions } from "./tools.js";

// Long-term memory as tools (recall + save)
export { createMemoryTools } from "./memory.js";
export type { CreateMemoryToolsConfig, MemoryUserId } from "./memory.js";

// Schema-driven Redis Search tools (search / aggregate / count)
export { createSearchTools } from "./search-tools.js";
export type { CreateSearchToolsConfig } from "./search-tools.js";

// Durable chat history (Redis-backed source of truth for UIMessage transcripts)
export { createChatHistory } from "./chat-history.js";
export type { CreateChatHistoryConfig } from "./chat-history.js";
export { ChatHistory } from "@upstash/agentkit-sdk";
export type { ChatRecord, ChatSearchHit, ChatSummary } from "@upstash/agentkit-sdk";
