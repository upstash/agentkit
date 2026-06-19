// Utilities
export { key, now, stableHash, stableStringify } from "./utils.js";

// Search index handle type (the raw Upstash Redis Search index features expose via `.searchIndex`)
export type { FilterValue, SearchHit, SearchIndexHandle } from "./search-index.js";
// Reactive index provisioning: run a search op, create the index + waitIndexing on missing, retry.
export { withIndex, isMissingIndexError } from "./search-index.js";

// Features
export { AgentMemory } from "./memory.js";
export type { AgentMemoryConfig, MemoryRecord, RecalledMemory } from "./memory.js";

export { ToolCache } from "./tool-cache.js";
export type { ToolCacheConfig, ToolCacheHit } from "./tool-cache.js";

export { chunkText, Rag } from "./rag.js";
export type { Chunk, ChunkOptions, RagConfig, RagDocument, RetrievedChunk } from "./rag.js";

export { createRateLimit } from "./rate-limit.js";
export type { RateLimitConfig } from "./rate-limit.js";

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
