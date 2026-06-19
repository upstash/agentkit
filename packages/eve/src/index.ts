// Structural Eve types (the adapter never imports a real `eve` package)
export type {
  EveAgentConfig,
  EveGenerateResult,
  EveGenerator,
  EveMessage,
  EveModel,
  EveTool,
  EveToolContext,
} from "./types.js";

// Message conversion
export { fromEveMessages, toEveMessages } from "./messages.js";

// Tool caching
export { cacheTools } from "./tools.js";
export type { CacheToolsConfig } from "./tools.js";

// Code-execution sandbox lives at the "@upstash/agentkit-eve/sandbox" subpath
// (it pulls in @upstash/box) — import { upstash } from "@upstash/agentkit-eve/sandbox".

// Memory hooks
export { createMemoryHooks } from "./memory.js";
export type { MemoryHooks, MemoryHooksConfig } from "./memory.js";

// Semantic cache
export { withSemanticCache, withSemanticCacheText } from "./semantic-cache.js";
export type { WithSemanticCacheConfig } from "./semantic-cache.js";

// Composed entry point
export { withAgentKit } from "./with-agentkit.js";
export type { AgentKitAugmentation, WithAgentKitConfig } from "./with-agentkit.js";
