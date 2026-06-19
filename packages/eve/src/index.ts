// Cached tools — like Eve's defineTool, but the result is memoized in an Upstash ToolCache
export { defineCachedTool } from "./tools.js";
export type { CacheNamespace, DefineCachedToolConfig } from "./tools.js";

// Long-term memory as Eve tools (drop into agent/tools/*.ts)
export { defineMemoryRecallTool, defineMemorySaveTool } from "./memory.js";
export type { MemoryNamespace, MemoryToolConfig } from "./memory.js";

// Model wrappers (rate limiting) — re-exported from the ai-sdk adapter (Eve uses AI SDK models).
export {
  rateLimitMiddleware,
  rateLimitedModel,
  RateLimitExceededError,
} from "@upstash/agentkit-ai-sdk";
export type { RateLimitMiddlewareConfig, RateLimitedModelConfig } from "@upstash/agentkit-ai-sdk";

// Code-execution sandbox (Upstash Box backend) lives at "@upstash/agentkit-eve/sandbox".
