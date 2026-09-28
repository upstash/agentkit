/**
 * Root entry: everything that needs only `@tanstack/ai`. The features built on TanStack's optional
 * packages have their own entry points, so their types never reach this one:
 * `@upstash/agentkit-tanstack-ai/persistence` (needs `@tanstack/ai-persistence`) and
 * `@upstash/agentkit-tanstack-ai/memory` (needs `@tanstack/ai-memory`).
 */

// Resumable delivery (`StreamDurability`) on Redis Streams — reload/reconnect/second device.
export { upstashStream } from "./stream/stream.js";
export type { UpstashStreamConfig, UpstashStreamInit } from "./stream/stream.js";

// The Redis primitives under `upstashLocks()` and `upstashStream()`, usable directly: a lease lock with
// fencing tokens, and a resumable append-only event log on Redis Streams.
export { RedisLock, LockAcquireTimeoutError, LockLostError } from "./locks/redis-lock.js";
export type { RedisLockConfig, LockLease } from "./locks/redis-lock.js";
export { EventLog, EventLogClosedError } from "./stream/event-log.js";
export type { EventLogConfig, LogEntry } from "./stream/event-log.js";

// Distributed `LockStore` for `withLocks()`.
export { upstashLocks } from "./locks/locks.js";
export type { UpstashLocksConfig } from "./locks/locks.js";

// Chat middlewares: tool-result caching and per-run rate limiting.
export { toolCache, rateLimit, RateLimitExceededError } from "./middleware/middleware.js";
export type {
  ToolCacheMiddlewareConfig,
  RateLimitMiddlewareConfig,
} from "./middleware/middleware.js";

// Schema-driven Redis Search tools (search / aggregate / count) for RAG.
export { createSearchTools } from "./search/search-tools.js";
export type { CreateSearchToolsConfig } from "./search/search-tools.js";

// Rate limiting primitives, re-exported so users never import `@upstash/ratelimit` directly.
export { createRateLimit, Ratelimit } from "@upstash/agentkit-sdk";
export type { RateLimitConfig, Duration } from "@upstash/agentkit-sdk";
