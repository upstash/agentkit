/**
 * `@upstash/mcp-toolkit/tasks` — durable long-running tools for MCP servers on the official TypeScript SDK.
 *
 * The core here is storage-agnostic. The Upstash Redis + QStash backends live behind the
 * `@upstash/mcp-toolkit/tasks/upstash` entry point, so bringing your own store costs you nothing.
 */
export {
  createTaskLayer,
  toWire,
  DEFAULT_TOOL_NAMES,
  type CallerAuth,
  type TaskHandler,
  type TaskLayer,
  type TaskLayerOptions,
  type TaskToolConfig,
} from "./core.js";

export {
  isTerminal,
  TERMINAL_STATUSES,
  UnknownTaskError,
  type Task,
  type TaskContext,
  type TaskDispatcher,
  type TaskError,
  type TaskPatch,
  type TaskEndpoints,
  type TaskStatus,
  type TaskStore,
  type TerminalTaskPatch,
  type TerminalTaskStatus,
  type WireTask,
} from "./types.js";

export { InlineTaskDispatcher, MemoryTaskStore } from "./backends/memory.js";

export { SDK_TELEMETRY } from "../telemetry.js";
export { VERSION } from "../version.js";
