/**
 * `@upstash/mcp-toolkit/tasks`: long-running tools for MCP servers on the official TypeScript SDK.
 * The Upstash backends are in `@upstash/mcp-toolkit/tasks/upstash`.
 */
export {
  createTaskLayer,
  toWire,
  DEFAULT_TOOL_NAMES,
  type Caller,
  type CallerAuth,
  type TaskDefinition,
  type TaskHandler,
  type TaskLayer,
  type TaskLayerOptions,
  type TaskToolConfig,
} from "./core.js";

export type { Principal, PrincipalResolver } from "../shared/auth.js";

export {
  dispatchKey,
  isTerminal,
  TERMINAL_STATUSES,
  UnknownTaskError,
  type SettleResult,
  type Task,
  type TaskContext,
  type TaskDispatcher,
  type TaskEndpoints,
  type TaskError,
  type TaskJournal,
  type TaskPatch,
  type TaskStatus,
  type TaskStore,
  type TerminalTaskPatch,
  type TerminalTaskStatus,
  type WireTask,
} from "./types.js";

export { InlineTaskDispatcher, MemoryTaskStore } from "./backends/memory.js";

export { SDK_TELEMETRY } from "../telemetry.js";
export { VERSION } from "../version.js";
