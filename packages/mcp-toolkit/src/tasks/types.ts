/**
 * The two seams of the tasks runtime: a {@link TaskStore} owns the task record, a
 * {@link TaskDispatcher} owns the execution. The core depends only on these.
 */
import type { InputRequests, StandardSchemaWithJSON } from "@modelcontextprotocol/server";

/**
 * A task's states, from the `io.modelcontextprotocol/tasks` extension. `input_required` means the
 * handler is waiting for the user's answer to `task.elicit`. The last three are terminal.
 */
export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

export type TerminalTaskStatus = Exclude<TaskStatus, "working" | "input_required">;

/**
 * The user's answer to one question, as `tasks/update` delivers it: an elicitation result. Already
 * checked for shape and size; `content` is still untrusted until `task.elicit` validates it.
 */
export type TaskInputResponse = {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, string | number | boolean | string[]>;
};

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
  /** The tool result, once `completed`, or once `failed` because the handler returned `isError`. */
  result?: Record<string, unknown>;
  /** Once `failed`. */
  error?: TaskError;
  /**
   * While `input_required`: the open questions, keyed. Each is an `elicitation/create` request, as
   * the extension carries it in `tasks/get`.
   */
  inputRequests?: InputRequests;
};

/** The stored task: the wire object plus server-only fields the model never sees. */
export type Task = WireTask & {
  /** The defined task name, which picks the handler. */
  name: string;
  /** The validated tool input. */
  args: unknown;
  /** The caller that started the task. Only they can read or cancel it. */
  owner: string;
  /** Every answer so far, by question key. Never shown to the model. */
  inputResponses?: Record<string, TaskInputResponse>;
};

/** The fields a write may change. */
export type TaskPatch = Partial<
  Pick<Task, "status" | "statusMessage" | "result" | "error" | "inputRequests">
>;

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

  /**
   * Records answers, atomically: only while the task is `input_required`, and only for keys in its
   * `inputRequests` that have no answer yet (anything else is ignored). When that leaves no open
   * question, the task goes back to `working` with this `statusMessage`, its `inputRequests` are
   * cleared, and this resolves the keys it was waiting on; otherwise it resolves `[]`. So exactly
   * one call resumes a task, and an answer after a cancel changes nothing.
   */
  respond(
    taskId: string,
    responses: Record<string, TaskInputResponse>,
    statusMessage: string,
  ): Promise<string[]>;
}

/**
 * Durable, at-least-once execution. `TContext` is what the transport gives a running handler:
 * nothing for a queue, the `WorkflowContext` for Upstash Workflow.
 */
export interface TaskDispatcher<TContext = unknown> {
  /** Durably accepts a delivery. `McpTasks` calls it once per task. */
  dispatch(task: Task): Promise<void>;

  /** Stops pending deliveries, when the transport can. Idempotent. */
  cancel(taskId: string): Promise<void>;

  /** The transport's delivery endpoint, which hands each delivery to `McpTasks`' entry points. */
  createExecuteHandler(endpoints: TaskEndpoints<TContext>): (request: Request) => Promise<Response>;

  /**
   * Optional. `McpTasks` calls it once, with its entry points, when it is constructed. A dispatcher that runs tasks itself, rather than through a delivery endpoint (like
   * `InProcessDispatcher`), keeps them here, so no execute endpoint has to be mounted.
   */
  connect?(endpoints: TaskEndpoints<TContext>): void;

  /**
   * Optional, with `resume`: how a running handler waits for the user's answer to `task.elicit`,
   * without which the dispatcher can't ask the user (declare {@link TaskInputContext} in
   * `TContext` only if you implement both). It resolves when the store is worth reading again:
   * when `resume` or `cancel` woke it, or after a while, and at the latest at `wait.expiresAt`.
   * `McpTasks` reads the store after each wait and calls it again until the question is answered,
   * cancelled or expired. On a replaying transport, `wait.key` and `wait.round` name it uniquely.
   */
  waitForInput?(wait: TaskInputWait, context: TransportContext<TContext>): Promise<void>;

  /** Optional. Wakes the handler waiting on these questions: `tasks/update` answered them. */
  resume?(taskId: string, keys: string[]): Promise<void>;
}

/** One wait for an answer: see {@link TaskDispatcher.waitForInput}. */
export type TaskInputWait = {
  taskId: string;
  /** The question's key in `inputRequests`. */
  key: string;
  /** 1 for the first wait on this question, then 2, 3… */
  round: number;
  /** When the task's record expires, in milliseconds since the epoch. */
  expiresAt: number;
  /** The task's poll interval, a sensible period for a dispatcher that polls. */
  pollIntervalMs: number;
};

/**
 * What a dispatcher that can wait for the user adds to the handler's `task`: `elicit`.
 * `InProcessDispatcher` (the default) and `WorkflowDispatcher` declare it in their context type, so
 * `task.elicit` only exists under them; `QStashDispatcher` doesn't, so under it `task.elicit` is a
 * type error.
 */
export type TaskInputContext = {
  /**
   * Asks the user a question through a form (an MCP elicitation) and waits for the answer. The
   * task is `input_required` meanwhile, and the client shows the form; once the user answers, the
   * handler carries on with the answer, validated against `requestedSchema`.
   *
   * Questions are keyed by call order (`elicit-1`, `elicit-2`, …), at most 16 per task, one at a
   * time. If the task is cancelled or expires while waiting, `elicit` throws and the handler stops
   * there: don't catch that error. With `WorkflowDispatcher`, call it outside `task.run`.
   */
  elicit<Schema extends StandardSchemaWithJSON>(params: {
    /** The question, shown to the user. */
    message: string;
    /** The form: a flat object of strings, numbers, booleans and enums (MCP elicitation). */
    requestedSchema: Schema;
  }): Promise<ElicitAnswer<SchemaOutput<Schema>>>;
};

/** The user's answer to `task.elicit`: the content only when they accepted. */
export type ElicitAnswer<Content> =
  | { action: "accept"; content: Content }
  | { action: "decline" }
  | { action: "cancel" };

type SchemaOutput<Schema> = Schema extends {
  readonly "~standard": { types?: { readonly output: infer Output } | undefined };
}
  ? Output
  : unknown;

/**
 * The context a transport hands `run`: its own part of the handler's context, without what
 * `McpTasks` adds itself (`elicit`). `undefined` when it adds nothing.
 */
export type TransportContext<TContext> = TContext extends TaskInputContext
  ? Omit<TContext, keyof TaskInputContext> | undefined
  : TContext;

/** `McpTasks`' entry points, handed to a dispatcher's `connect` and execute handler. */
export type TaskEndpoints<TContext = unknown> = {
  /** Runs a delivered task. Rejects if the handler threw, which means "deliver again". */
  run(taskId: string, context: TransportContext<TContext>, journal?: TaskJournal): Promise<void>;
  /** Records a terminal failure, once the transport has stopped retrying. */
  fail(taskId: string, error: TaskError): Promise<void>;
};

/** How a replaying transport runs a side effect once. The core wraps `task.update` with it. */
export type TaskJournal = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

/** What every handler is handed, whatever the transport. */
export type TaskContext = {
  taskId: string;
  /**
   * The caller that started the task: what `principal` returned for that call. Use it to scope
   * what the handler touches to that user; never take a user id from the tool arguments.
   */
  principal: string;
  /** Publishes a progress line that the next `task_status` poll will see. */
  update(statusMessage: string): Promise<void>;
  /** True once the client cancelled, or the record expired. Cooperative: check at step boundaries. */
  isCancelled(): Promise<boolean>;
};
