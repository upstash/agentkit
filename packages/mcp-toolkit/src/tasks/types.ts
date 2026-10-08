/**
 * The two seams of the tasks runtime: a {@link TaskStore} owns the task record, a
 * {@link TaskDispatcher} owns the execution. The core depends only on these.
 */

/** A task's states, from the `io.modelcontextprotocol/tasks` extension. The last three are terminal. */
export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

export type TerminalTaskStatus = Extract<TaskStatus, "completed" | "failed" | "cancelled">;

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export const isTerminal = (status: TaskStatus): status is TerminalTaskStatus =>
  TERMINAL_STATUSES.has(status);

/** Thrown by a store for an unknown or expired task. Not an MCP error, so stores need no SDK. */
export class UnknownTaskError extends Error {
  override readonly name = "UnknownTaskError";
  constructor(readonly taskId: string) {
    super(`Unknown task: ${taskId}`);
  }
}

/** A JSON-RPC error, as carried by a `failed` task. */
export type TaskError = {
  code: number;
  message: string;
  data?: unknown;
};

/** What the model sees in `structuredContent`: the extension's task object. */
export type WireTask = {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601. */
  lastUpdatedAt: string;
  /** Retention window in milliseconds. `null` means unlimited. */
  ttlMs: number | null;
  pollIntervalMs?: number;
  /** The tool result, once `completed`. */
  result?: Record<string, unknown>;
  /** Once `failed`. */
  error?: TaskError;
};

/** The stored task: the wire object plus server-only fields the model never sees. */
export type Task = WireTask & {
  /** The defined task name, which picks the handler. */
  name: string;
  /** The validated tool input. */
  args: unknown;
  /** The dispatcher's handle, so cancel can stop pending deliveries. */
  dispatchId?: string;
  /** The caller that started the task. Only they can read or cancel it. */
  owner: string;
};

export type TaskPatch = Partial<Omit<Task, "taskId" | "createdAt" | "owner">>;

export type TerminalTaskPatch = TaskPatch & { status: TerminalTaskStatus };

/** What {@link TaskStore.settle} returns for an existing task. */
export type SettleResult = {
  /** The task after the call: settled by it, or unchanged because it was already terminal. */
  task: Task;
  /** True only for the call that performed the terminal transition. */
  settled: boolean;
};

export interface TaskStore {
  /**
   * Durably creates a task unless one with that id exists, atomically. Resolves `null` when it
   * created the task, or the existing task otherwise.
   */
  create(task: Task): Promise<Task | null>;

  /** The latest state of a task, or `null` when it is absent or expired. */
  get(taskId: string): Promise<Task | null>;

  /**
   * Applies a non-terminal patch without extending the TTL. A terminal task is returned
   * unchanged. Throws {@link UnknownTaskError} when the task is missing.
   */
  update(taskId: string, patch: TaskPatch): Promise<Task>;

  /**
   * Atomically moves a non-terminal task to a terminal state. First terminal write wins, so a late
   * `completed` cannot overwrite a `cancelled`. Resolves `null` when the task is missing.
   */
  settle(taskId: string, patch: TerminalTaskPatch): Promise<SettleResult | null>;
}

/**
 * Durable, at-least-once execution. `TContext` is what the transport gives a running handler:
 * nothing for a queue, the `WorkflowContext` for Upstash Workflow.
 */
export interface TaskDispatcher<TContext = unknown> {
  /**
   * Durably accepts a delivery and returns a handle for {@link cancel}. Must be idempotent per
   * task id, which is a random UUID.
   */
  dispatch(task: Task): Promise<string | undefined>;

  /** Stops pending deliveries, when the transport can. Idempotent. */
  cancel(dispatchId: string): Promise<void>;

  /** Receives the layer's entry points when passed to `createTaskLayer`. */
  attach?(endpoints: TaskEndpoints<TContext>): void;

  /** The transport's delivery endpoint, for dispatchers that deliver over HTTP. */
  createExecuteHandler?(): (request: Request) => Promise<Response>;
}

/** The layer's entry points, handed to a dispatcher by {@link TaskDispatcher.attach}. */
export type TaskEndpoints<TContext = unknown> = {
  /** Runs a delivered task. Rejects if the handler threw, which means "deliver again". */
  run(taskId: string, context: TContext, journal?: TaskJournal): Promise<unknown>;
  /** Records a terminal failure, once the transport has stopped retrying. */
  fail(taskId: string, error: TaskError): Promise<unknown>;
};

/** How a replaying transport runs a side effect once. The core wraps `task.update` with it. */
export type TaskJournal = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

/** What every handler is handed, whatever the transport. */
export type TaskContext = {
  taskId: string;
  /** Publishes a progress line that the next `task_status` poll will see. */
  update(statusMessage: string): Promise<void>;
  /** True once the client cancelled, or the record expired. Cooperative: check at step boundaries. */
  isCancelled(): Promise<boolean>;
};
