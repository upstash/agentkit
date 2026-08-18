// Utilities
export { key, now, stableHash, stableStringify } from "./utils.js";

// Telemetry — tags the redis client's `Upstash-Telemetry-Sdk` header. Adapter packages call this
// with their own `sdk` tag; opt out per feature with `enableTelemetry: false`, on the redis client,
// or with the `UPSTASH_DISABLE_TELEMETRY` env var.
export { addTelemetry, SDK_TELEMETRY } from "./telemetry.js";
export { VERSION } from "./version.js";

// Reactive search index — provisions the Upstash index on first read; the type each feature's
// `.searchIndex` getter returns.
export { ReactiveSearchIndex } from "./reactive-index.js";
export type { ReactiveSearchIndexConfig, AnySearchSchema } from "./reactive-index.js";

// Features
export { AgentMemory } from "./memory.js";
export type { AgentMemoryConfig, MemoryRecord, RecalledMemory } from "./memory.js";

export { ToolCache } from "./tool-cache.js";
export type { ToolCacheConfig, ToolCacheHit } from "./tool-cache.js";

export { createRateLimit, Ratelimit } from "./rate-limit.js";
export type { RateLimitConfig, Duration } from "./rate-limit.js";

export { ChatHistory } from "./chat-history.js";
export type {
  ChatHistoryConfig,
  ChatRecord,
  ChatSearchHit,
  ChatSummary,
  ExtractedText,
} from "./chat-history.js";

// Framework-agnostic search-tool definitions (search / aggregate / count over a Redis Search index)
export { createSearchToolDefs } from "./search-tools.js";
export type { SearchToolDef, SearchToolDefs, SearchToolDefsConfig } from "./search-tools.js";
