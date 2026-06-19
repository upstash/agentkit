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

// Tool caching + tracing
export { cacheTools } from "./tools.js";
export type { CacheToolsConfig } from "./tools.js";

// Code-execution sandbox integration (Eve's `eve/sandbox`)
export { instrumentSandboxSession, withSandboxInstrumentation } from "./sandbox.js";
export type {
  DefineSandboxConfig,
  EveSandboxRunResult,
  EveSandboxSession,
  EveSandboxUse,
  SandboxInstrumentation,
} from "./sandbox.js";

// Memory hooks
export { createMemoryHooks } from "./memory.js";
export type { MemoryHooks, MemoryHooksConfig } from "./memory.js";

// History hooks
export { createHistoryHooks } from "./history.js";
export type { HistoryHooks, HistoryHooksConfig } from "./history.js";

// Semantic cache
export { withSemanticCache, withSemanticCacheText } from "./semantic-cache.js";
export type { WithSemanticCacheConfig } from "./semantic-cache.js";

// Telemetry
export { traceRun } from "./telemetry.js";
export type { TraceRunConfig } from "./telemetry.js";

// Composed entry point
export { withAgentKit } from "./with-agentkit.js";
export type { AgentKitAugmentation, WithAgentKitConfig } from "./with-agentkit.js";
