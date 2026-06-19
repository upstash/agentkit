// Structural AI SDK interfaces (the adapter never imports the real `ai` package).
export type {
  AiTool,
  CoreMessageLike,
  GenerateTextResultLike,
  PromptGenerator,
  TextPartLike,
  TokenUsageLike,
  ToolExecuteOptions,
} from "./types.js";

// Message conversion
export { fromCoreMessages, toCoreMessages } from "./messages.js";

// Semantic-cached generation
export { withSemanticCache, withSemanticCacheText } from "./semantic-cache.js";
export type { WithSemanticCacheConfig } from "./semantic-cache.js";

// Tool wrapping (tool cache memoization)
export { wrapTool } from "./tools.js";
export type { WrapToolConfig } from "./tools.js";

// Memory injection
export { withMemory } from "./memory.js";
export type { MemoryInjector, WithMemoryConfig } from "./memory.js";

// Schema-driven Redis Search tools (query / aggregate / count)
export { createSearchTools } from "./search-tools.js";
export type { CreateSearchToolsConfig } from "./search-tools.js";
