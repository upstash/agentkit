// Core types & interfaces
export type {
  ChatMessage,
  Embedder,
  Logger,
  RedisLike,
  RedisSetOptions,
  VectorMatch,
  VectorQuery,
  VectorRecord,
  VectorStore,
} from "./types.js";

// Utilities
export {
  cosineSimilarity,
  key,
  noopLogger,
  now,
  stableHash,
  stableStringify,
  toQueryPayload,
  toVectorPayload,
} from "./utils.js";

// Adapters
export { upstashVectorStore } from "./adapters.js";
export type { UpstashVectorIndex } from "./adapters.js";

// Features
export { ChatHistory } from "./chat-history.js";
export type { ChatHistoryConfig } from "./chat-history.js";

export { AgentMemory } from "./memory.js";
export type { AgentMemoryConfig, MemoryRecord, RecalledMemory } from "./memory.js";

export { SemanticCache } from "./semantic-cache.js";
export type { SemanticCacheConfig, SemanticCacheHit } from "./semantic-cache.js";

export { ToolCache } from "./tool-cache.js";
export type { ToolCacheConfig, ToolCacheHit } from "./tool-cache.js";

export { Span, Telemetry } from "./telemetry.js";
export type { SpanData, SpanStatus, SpanType, TelemetryConfig } from "./telemetry.js";

export { Sandbox, ToolTimeoutError } from "./sandbox.js";
export type { SandboxConfig, SandboxResult, Tool, ToolContext } from "./sandbox.js";

export { chunkText, Rag } from "./rag.js";
export type { Chunk, ChunkOptions, RagConfig, RagDocument, RetrievedChunk } from "./rag.js";
