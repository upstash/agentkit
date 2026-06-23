// Cached tools — like Eve's defineTool, but the result is memoized in an Upstash ToolCache
export { defineCachedTool } from "./tools.js";
export type { CacheNamespace, DefineCachedToolConfig } from "./tools.js";

// Long-term memory as Eve tools (drop into agent/tools/*.ts)
export { defineMemoryRecallTool, defineMemorySaveTool } from "./memory.js";
export type { MemoryNamespace, MemoryToolConfig } from "./memory.js";

// Schema-driven Redis Search tools (search / aggregate / count) as eve tools
export { defineSearchTools } from "./search-tools.js";
export type { DefineSearchToolsConfig, SearchToolSet } from "./search-tools.js";

// Rate limiting — `createRateLimitAuth` is a ready eve route-auth `AuthFn` (drop into
// `agent/channels/eve.ts`'s `auth` walk). `createRateLimit` is the underlying core factory for
// custom use. Keys are `agentkit:rateLimit:<identifier>`.
export { createRateLimitAuth } from "./auth.js";
export type { RateLimitAuthConfig } from "./auth.js";
// `Ratelimit` (for custom limiters like `Ratelimit.fixedWindow(...)`) and the `Duration` type are
// re-exported too, so users never import from (or install) `@upstash/ratelimit` directly.
export { createRateLimit, Ratelimit } from "@upstash/agentkit-sdk";
export type { RateLimitConfig, Duration } from "@upstash/agentkit-sdk";

// Code-execution sandbox (Upstash Box backend) lives at "@upstash/agentkit-eve/sandbox".
