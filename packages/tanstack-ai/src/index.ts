// Structural interfaces (TanStack AI is an optional peer; nothing real is imported)
export type { GenerateFn, TanStackMessage, TanStackRole, TanStackTool } from "./types.js";

// Message conversion
export {
  fromTanStackMessage,
  fromTanStackMessages,
  toTanStackMessage,
  toTanStackMessages,
} from "./messages.js";

// Persistent chat-history adapter
export { createChatHistoryAdapter } from "./history-adapter.js";
export type { ChatHistoryAdapter, ChatHistoryAdapterConfig } from "./history-adapter.js";

// Server-side chat handler
export { createChatHandler } from "./chat-handler.js";
export type {
  ChatGenerate,
  ChatHandlerConfig,
  ChatTurnInput,
  ChatTurnResult,
} from "./chat-handler.js";

// Tool caching / sandboxing
export { wrapTool, wrapTools } from "./tools.js";
export type { WrapToolsOptions } from "./tools.js";

// Semantic cache + memory enhancers
export { withMemory, withSemanticCache } from "./enhancers.js";
export type { MemoryInjector, MemoryOptions, SemanticCacheOptions } from "./enhancers.js";
