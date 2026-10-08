/**
 * The two seams of the tasks runtime: a {@link TaskStore} owns the task record, a
 * {@link TaskDispatcher} owns the execution. The core depends only on these.
 */

/** A task's states, from the `io.modelcontextprotocol/tasks` extension. The last three are terminal. */
export type TaskStatus = "working" | "completed" | "failed" | "cancelled";

export type TerminalTaskStatus = Exclude<TaskStatus, "working">;

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
  /** Retention window in milliseconds, from creation. */
  ttlMs: number;
  pollIntervalMs: number;
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
  /** The caller that started the task. Only they can read or cancel it. */
  owner: string;
};

/** The fields a write may change. */
export type TaskPatch = Partial<Pick<Task, "status" | "statusMessage" | "result" | "error">>;

export interface TaskStore {
  /** Durably creates a task, with its TTL. Task ids are random UUIDs. */
  create(task: Task): Promise<void>;

  /** The latest state of a task, or `null` when it is absent or expired. */
  get(taskId: string): Promise<Task | null>;

  /** Applies a non-terminal patch without extending the TTL. A no-op on a terminal or missing task. */
  update(taskId: string, patch: TaskPatch): Promise<void>;

  /**
   * Atomically moves a non-terminal task to a terminal state, and returns the task after the call.
   * First terminal write wins, so a late `completed` cannot overwrite a `cancelled`. Resolves
   * `null` when the task is missing.
   */
  settle(taskId: string, patch: TaskPatch & { status: TerminalTaskStatus }): Promise<Task | null>;
}

/**
 * Durable, at-least-once execution. `TContext` is what the transport gives a running handler:
 * nothing for a queue, the `WorkflowContext` for Upstash Workflow.
 */
export interface TaskDispatcher<TContext = unknown> {
  /** Durably accepts a delivery. Must be idempotent per task id. */
  dispatch(task: Task): Promise<void>;

  /** Stops pending deliveries, when the transport can. Idempotent. */
  cancel(taskId: string): Promise<void>;

  /** The transport's delivery endpoint, which hands each delivery to the layer's entry points. */
  createExecuteHandler(endpoints: TaskEndpoints<TContext>): (request: Request) => Promise<Response>;
}

/** The layer's entry points, handed to a dispatcher's execute handler. */
export type TaskEndpoints<TContext = unknown> = {
  /** Runs a delivered task. Rejects if the handler threw, which means "deliver again". */
  run(taskId: string, context: TContext, journal?: TaskJournal): Promise<void>;
  /** Records a terminal failure, once the transport has stopped retrying. */
  fail(taskId: string, error: TaskError): Promise<void>;
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
