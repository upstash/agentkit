/**
 * `@upstash/mcp-toolkit/tasks`: long-running tools for MCP servers on the official TypeScript SDK.
 * The Upstash backends are in `@upstash/mcp-toolkit/upstash`.
 */
export {
  createTaskLayer,
  type TaskHandler,
  type TaskLayer,
  type TaskLayerOptions,
  type TaskToolConfig,
} from "./core.js";

export type { Caller, PrincipalResolver } from "../shared/auth.js";

export type {
  Task,
  TaskContext,
  TaskDispatcher,
  TaskEndpoints,
  TaskError,
  TaskJournal,
  TaskPatch,
  TaskStatus,
  TaskStore,
  TerminalTaskStatus,
  WireTask,
} from "./types.js";
