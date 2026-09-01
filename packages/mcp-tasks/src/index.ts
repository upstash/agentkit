/**
 * `@upstash/mcp-tasks` — a durable MCP Tasks runtime for the official TypeScript SDK.
 *
 * The core here is storage-agnostic. The Upstash Redis + QStash backends live behind the
 * `@upstash/mcp-tasks/upstash` entry point, so bringing your own store costs you nothing.
 */
export {
  createTaskLayer,
  toWire,
  TASK_METHODS,
  TASKS_EXTENSION,
  TASKS_PROTOCOL_VERSION,
  type ExecuteTaskOptions,
  type MissingCapabilityBehavior,
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
  type TaskRunner,
  type TaskStatus,
  type TaskStore,
  type TerminalTaskPatch,
  type TerminalTaskStatus,
  type WireTask,
} from "./types.js";

export { InlineTaskDispatcher, MemoryTaskStore } from "./memory.js";

export { SDK_TELEMETRY } from "./telemetry.js";
export { VERSION } from "./version.js";
