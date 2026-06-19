// Cached tools — like Eve's defineTool, but the result is memoized in an Upstash ToolCache
export { defineCachedTool } from "./tools.js";
export type { CacheNamespace, DefineCachedToolConfig } from "./tools.js";

// Long-term memory as Eve tools (drop into agent/tools/*.ts)
export { defineMemoryRecallTool, defineMemorySaveTool } from "./memory.js";
export type { MemoryNamespace, MemoryToolConfig } from "./memory.js";

// Rate limiting — `createRateLimitAuth` is a ready eve route-auth `AuthFn` (drop into
// `agent/channels/eve.ts`'s `auth` walk). `createRateLimit` is the underlying core factory for
// custom use. Keys are `agentkit:rateLimit:<identifier>`.
export { createRateLimitAuth } from "./auth.js";
export type { RateLimitAuthConfig } from "./auth.js";
export { createRateLimit } from "@upstash/agentkit-sdk";
export type { RateLimitConfig } from "@upstash/agentkit-sdk";

// Code-execution sandbox (Upstash Box backend) lives at "@upstash/agentkit-eve/sandbox".
