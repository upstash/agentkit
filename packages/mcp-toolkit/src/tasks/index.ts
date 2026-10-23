/**
 * `@upstash/mcp-toolkit/tasks`: long-running tools for MCP servers on the official TypeScript SDK.
 * The in-memory backends (the defaults) are here; the durable Upstash backends are in
 * `@upstash/mcp-toolkit/upstash`.
 */
export {
  McpTasks,
  type McpTasksOptions,
  type TaskHandler,
  type TaskMode,
  type TaskToolConfig,
  type TaskAuthorizeCaller,
} from "./core.js";

export { InProcessDispatcher, MemoryTaskStore } from "./memory.js";

export type { Caller, PrincipalResolver } from "../shared/auth.js";

export type {
  ElicitAnswer,
  Task,
  TaskContext,
  TaskDispatcher,
  TaskEndpoints,
  TaskError,
  TaskInputResponse,
  TaskInputWait,
  TaskJournal,
  TaskPatch,
  TaskStatus,
  TaskStore,
  TerminalTaskStatus,
  WireTask,
} from "./types.js";
