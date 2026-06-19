// Core types
export type { ChatMessage, Logger } from "./types.js";

// Utilities
export { key, noopLogger, now, stableHash, stableStringify } from "./utils.js";

// Search index handle type (the raw Upstash Redis Search index features expose via `.searchIndex`)
export type { FilterValue, SearchHit, SearchIndexHandle } from "./search-index.js";

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

export { chunkText, Rag } from "./rag.js";
export type { Chunk, ChunkOptions, RagConfig, RagDocument, RetrievedChunk } from "./rag.js";
