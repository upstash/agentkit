// Structural LangChain interfaces (this package never imports a real LangChain package).
export type {
  BaseMessageLike,
  CacheLike,
  ChatMessageHistoryLike,
  DocumentLike,
  GenerationLike,
  RetrieverLike,
  ToolLike,
} from "./types.js";

// Message conversion
export {
  fromLangChainMessage,
  readMessageRole,
  toAgentKitRole,
  toLangChainMessage,
  toLangChainType,
} from "./messages.js";
export type { AgentKitRole } from "./messages.js";

// Chat message history
export { RedisChatMessageHistory } from "./chat-message-history.js";
export type { RedisChatMessageHistoryConfig } from "./chat-message-history.js";

// Retriever
export { AgentKitRetriever } from "./retriever.js";
export type { AgentKitRetrieverConfig, IngestDocument } from "./retriever.js";

// Semantic LLM cache
export { SemanticLLMCache } from "./llm-cache.js";

// Tool wrapping helpers
export { cacheTool } from "./tools.js";

// Long-term memory
export { AgentKitMemory } from "./memory.js";
export type { AgentKitMemoryConfig } from "./memory.js";
