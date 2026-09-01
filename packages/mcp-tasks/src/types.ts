/**
 * The storage and execution seams of the tasks runtime.
 *
 * MCP Tasks says how a client and a server talk about long-running work; it says nothing about
 * where that work runs. Those are two different durability problems, so they get two interfaces:
 * a {@link TaskStore} owns the task *record*, a {@link TaskDispatcher} owns the *execution*. The
 * core in `core.ts` depends only on these, so Upstash Redis + QStash (`upstash.ts`) are a swap,
 * not a hard-coded backend.
 */

/**
 * The five states of the `io.modelcontextprotocol/tasks` extension. `completed`, `failed` and
 * `cancelled` are terminal: once a task reaches one, its status never changes again.
 */
export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

/** The three terminal states, as a type. */
export type TerminalTaskStatus = Extract<TaskStatus, "completed" | "failed" | "cancelled">;

/** The terminal states, as a runtime set. */
export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "completed",
  "failed",
  "cancelled",
]);

/** True when a status is terminal and can never transition again. */
export const isTerminal = (status: TaskStatus): status is TerminalTaskStatus =>
  TERMINAL_STATUSES.has(status);

/**
 * Thrown by a {@link TaskStore} when a task id does not resolve — unknown, or expired past its TTL.
 *
 * It is deliberately *not* an MCP `ProtocolError`: a store implementation should not have to
 * import the MCP SDK to be a valid store. The core translates this into the protocol error the
 * client sees.
 */
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

/**
 * Exactly the object a client sees, straight from the extension's draft schema. Everything the
 * server keeps for itself lives on {@link Task} instead, and is stripped on the way out.
 */
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
  /** How long the client should wait between `tasks/get` polls. */
  pollIntervalMs?: number;
  /** Present once the task is `completed`: the tool result, inline. */
  result?: Record<string, unknown>;
  /** Present once the task is `failed`. */
  error?: TaskError;
};

/**
 * The stored task: the wire object plus the three fields the server needs and the client never
 * sees — which tool to run, what to run it with, and which dispatch to cancel.
 */
export type Task = WireTask & {
  /** The registered task name, so the executor knows which handler to run. */
  name: string;
  /** The validated tool input, replayed into the handler on delivery. */
  args: unknown;
  /** The dispatcher's handle for the pending delivery, so cancel can stop retries. */
  dispatchId?: string;
};

/** The fields a caller may patch on a stored task. */
export type TaskPatch = Partial<Omit<Task, "taskId" | "createdAt">>;

/** A patch that moves a task into a terminal state. */
export type TerminalTaskPatch = TaskPatch & { status: TerminalTaskStatus };

/**
 * Durable storage for the task record.
 *
 * The one hard requirement comes from the spec: a `tools/call` must not return the task handle
 * until the task is durably created, because the client may immediately `tasks/get` it against a
 * different instance. So {@link create} must have committed before it resolves.
 */
export interface TaskStore {
  /** Durably persists a new task before resolving. */
  create(task: Task): Promise<void>;

  /** Returns the latest durable state of a task, or `null` when it is absent or expired. */
  get(taskId: string): Promise<Task | null>;

  /**
   * Applies a partial update without extending the task's original TTL — the retention window is
   * measured from creation, so a chatty progress handler must not keep a task alive forever.
   *
   * Used for non-terminal writes (progress messages). Terminal transitions go through
   * {@link settle} so they cannot race.
   */
  update(taskId: string, patch: TaskPatch): Promise<Task>;

  /**
   * Atomically moves a **non-terminal** task to a terminal state. Returns the settled task when
   * this call performed the transition, or `null` when the task was already terminal.
   *
   * This is the one operation that must not be a read-modify-write, because two writers race for
   * it by design: a client's `tasks/cancel` and the executor finishing at the same moment. First
   * terminal write wins, and a late `completed` can never overwrite a `cancelled`.
   */
  settle(taskId: string, patch: TerminalTaskPatch): Promise<Task | null>;
}

/**
 * Durable execution transport.
 *
 * A store keeps the record alive across a restart; only a dispatcher keeps the *work* alive. The
 * contract is deliberately at-least-once — that is what a queue can actually promise — so the
 * core guards against redelivery rather than assuming a message arrives exactly once.
 */
export interface TaskDispatcher {
  /**
   * Durably accepts an at-least-once delivery for a task before resolving, and returns a handle
   * that {@link cancel} understands. Return `undefined` when the transport has nothing to cancel.
   *
   * Implementations should be idempotent in the task id: dispatching the same task twice must
   * not enqueue two deliveries.
   */
  dispatch(taskId: string): Promise<string | undefined>;

  /** Idempotently stops a pending delivery and its future retries, when the transport can. */
  cancel(dispatchId: string): Promise<void>;

  /**
   * Optionally, the transport's own delivery endpoint.
   *
   * A dispatcher that delivers over HTTP knows things the application should not have to: how the
   * request is authenticated, where the task id sits in the body, which attempt this is, and which
   * status code means "retry me". Implementing this keeps all of that inside the transport, so the
   * application's route is `export const POST = tasks.createExecuteHandler()` rather than a
   * hand-written endpoint that has to remember to verify a signature.
   *
   * Dispatchers that run work in-process have nothing to serve and leave it undefined.
   */
  createExecuteHandler?(run: TaskRunner): (request: Request) => Promise<Response>;
}

/**
 * What a delivery endpoint calls to run a task — `executeTask`, with the attempt's finality
 * already worked out by the transport that knows how to count its own retries.
 */
export type TaskRunner = (taskId: string, options: { isFinalAttempt: boolean }) => Promise<unknown>;

/** What a task handler is handed alongside its arguments. */
export type TaskContext = {
  /** The id of the running task. */
  taskId: string;
  /** Publishes a human-readable progress line that the client's next poll will see. */
  update(statusMessage: string): Promise<void>;
  /**
   * Reads the durable status to see whether a client asked to stop. Cancellation is cooperative:
   * running code only stops where it checks, so call this at your step boundaries.
   */
  isCancelled(): Promise<boolean>;
};
