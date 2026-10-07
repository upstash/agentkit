/**
 * The tasks runtime.
 *
 * Long-running work over MCP, served as **ordinary tools**. A task tool answers immediately with a
 * task handle; two shared tools, `task_status` and `task_cancel`, poll and stop it. The work runs
 * behind a {@link TaskDispatcher} (QStash, Upstash Workflow, or in-process), and the record lives
 * in a {@link TaskStore} (Upstash Redis, or memory).
 *
 * Why tools rather than the protocol's own Tasks extension (`io.modelcontextprotocol/tasks`): as of
 * October 2026 no mainstream client declares it — not Claude Code, Codex, Cursor or OpenCode — and
 * a server must never return a task to a client that did not. Plain tools work in every client
 * today, and they need nothing from the SDK beyond `registerTool`, so this layer serves through
 * `createMcpHandler`, `mcp-handler` or any transport unchanged. The store and dispatcher are the
 * same either way, so a native adapter can sit on top of them once clients catch up.
 *
 * {@link createTaskLayer} is the whole runtime, in one factory over a store and a dispatcher.
 */
import { createHash, randomUUID } from "node:crypto";
import type { McpServer, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import * as z from "zod";
import {
  isTerminal,
  UnknownTaskError,
  type Task,
  type TaskContext,
  type TaskDispatcher,
  type TaskError,
  type TaskJournal,
  type TaskStore,
  type WireTask,
} from "./types.js";

const DEFAULT_TTL_MS = 300_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** The names the two shared tools are registered under, unless overridden. */
export const DEFAULT_TOOL_NAMES = { status: "task_status", cancel: "task_cancel" } as const;

/**
 * The slice of the SDK's `AuthInfo` this layer reads. Typed structurally so a principal resolver
 * does not need to import the SDK's auth types.
 */
export type CallerAuth = {
  clientId?: string;
  scopes?: string[];
  extra?: Record<string, unknown>;
  [key: string]: unknown;
};

export type TaskLayerOptions<TContext = unknown> = {
  /** Durable storage for the task record. */
  store: TaskStore;
  /** Durable transport for the work itself. */
  dispatcher: TaskDispatcher<TContext>;
  /** Fallback values for tasks that do not set their own. */
  defaults?: {
    /** Retention window. `null` means unlimited. Defaults to 5 minutes. */
    ttlMs?: number | null;
    /** Suggested poll interval, returned to the model. Defaults to 2s. */
    pollIntervalMs?: number;
  };
  /**
   * Who is calling, as a stable string — usually your user id. When it returns a value, every
   * task records it as its owner, and `task_status` / `task_cancel` only answer for tasks the same
   * caller owns. Another caller's task id reads exactly like an unknown one.
   *
   * Receives the `AuthInfo` your auth middleware attached to the request. Leave it unset only for
   * a single-tenant server: without it, anyone holding a task id can read and cancel that task.
   *
   * ```ts
   * principal: (auth) => auth?.extra?.userId as string | undefined
   * ```
   *
   * Note that `auth.clientId` is the OAuth *client* (e.g. one id for every ChatGPT user), so it is
   * usually the wrong key on its own.
   */
  principal?: (auth: CallerAuth | undefined) => string | undefined;
  /** Rename the two shared tools, e.g. to namespace them next to other servers' tools. */
  toolNames?: { status?: string; cancel?: string };
};

export type TaskToolConfig<Schema extends StandardSchemaWithJSON, Args = InferArgs<Schema>> = {
  /** Human-readable title for `tools/list`. */
  title?: string;
  /**
   * What the tool does, for the model. The layer appends one sentence telling the model the call
   * returns a task id to poll, so this only needs to describe the work.
   */
  description: string;
  /** A Standard Schema (Zod 4, ArkType, Valibot) describing the tool's arguments. */
  inputSchema: Schema;
  /** Retention window for this tool's tasks. `null` means unlimited. */
  ttlMs?: number | null;
  /** Poll interval to suggest for this tool's tasks. */
  pollIntervalMs?: number;
  /** Status message set at creation. Defaults to `"Queued for durable execution"`. */
  queuedMessage?: string;
  /** Status message set on success. Defaults to `"Completed"`. */
  completedMessage?: string;
  /**
   * Derives an idempotency key from the arguments. Two calls from the same caller that produce
   * the same key, while the first task is still retained, return the **same** task instead of
   * starting a second one — which is what an agent retrying a timed-out tool call needs.
   *
   * Return `undefined` to opt a call out. To dedupe identical calls outright, return a stable
   * serialization of the arguments; to let the model choose, add a field to your schema and
   * return it here.
   */
  idempotencyKey?: (args: Args) => string | undefined;
};

/** Infers a Standard Schema's parsed output type. */
type InferArgs<Schema extends StandardSchemaWithJSON> = Schema extends {
  readonly "~standard": { types?: { readonly output: infer Output } | undefined };
}
  ? Output
  : unknown;

/**
 * A task's implementation.
 *
 * The context is the {@link TaskContext} intersected with whatever the dispatcher adds: nothing on
 * a queue, the live `WorkflowContext` on a workflow engine. One object either way, so a workflow
 * handler calls `task.update(...)` and `task.run(...)` side by side.
 *
 * Return an MCP tool result (`content`, optionally `structuredContent`). The model receives it
 * from `task_status` once the task completes.
 */
export type TaskHandler<Args, TContext = unknown> = (
  args: Args,
  task: TaskContext & TContext,
) => Promise<Record<string, unknown>>;

export type TaskLayer<TContext = unknown> = {
  /**
   * Registers a tool whose calls start a task and answer with its handle. The first call on a
   * server also registers the shared `task_status` and `task_cancel` tools.
   */
  registerTask<Schema extends StandardSchemaWithJSON>(
    server: McpServer,
    name: string,
    config: TaskToolConfig<Schema>,
    handler: TaskHandler<InferArgs<Schema>, TContext>,
  ): void;
  /**
   * Runs a dispatched task. Normally you do not call this — the dispatcher does, through the
   * handler returned by {@link TaskLayer.createExecuteHandler}.
   *
   * It **rejects** if the handler threw, and deliberately leaves the task non-terminal. Deciding
   * that a failure is final means knowing whether the transport will deliver again, and only the
   * transport knows that: QStash counts deliveries and calls a failure callback when it gives up,
   * a workflow engine retries per step and has its own failure hook, an in-process dispatcher has
   * no retries at all. Settling `failed` on the first error would make the task terminal and turn
   * every later redelivery into a no-op — the opposite of what retries are for.
   */
  executeTask(taskId: string, context?: TContext, journal?: TaskJournal): Promise<Task | null>;
  /** Records a terminal failure. Called by the dispatcher once it has stopped retrying. */
  failTask(taskId: string, error: TaskError): Promise<Task | null>;
  /**
   * The delivery endpoint as a fetch handler, when the dispatcher provides one:
   *
   * ```ts
   * // app/api/execute/route.ts
   * export const POST = tasks.createExecuteHandler();
   * ```
   *
   * The transport owns authentication, the attempt count and the retry status codes, so the
   * application does not have to re-derive them — and cannot forget to verify a signature.
   * Throws if the dispatcher runs work in-process and has no endpoint to serve.
   */
  createExecuteHandler(): (request: Request) => Promise<Response>;
  /** Reads a task record server-side, bypassing ownership checks. */
  getTask(taskId: string): Promise<Task | null>;
  /** Cancels a task server-side, bypassing ownership checks. Idempotent. */
  cancelTask(taskId: string): Promise<Task | null>;
  /** The store this layer was built on. */
  store: TaskStore;
  /** The dispatcher this layer was built on. */
  dispatcher: TaskDispatcher<TContext>;
};

/**
 * Builds a tasks runtime over a store and a dispatcher.
 *
 * ```ts
 * const tasks = createTaskLayer({
 *   store: new RedisTaskStore(),
 *   dispatcher: new QStashDispatcher({ url: `${process.env.APP_URL}/api/execute` }),
 * });
 * ```
 */
export function createTaskLayer<TContext = unknown>(
  options: TaskLayerOptions<TContext>,
): TaskLayer<TContext> {
  const { store, dispatcher, defaults = {}, principal } = options;
  const toolNames = {
    status: options.toolNames?.status ?? DEFAULT_TOOL_NAMES.status,
    cancel: options.toolNames?.cancel ?? DEFAULT_TOOL_NAMES.cancel,
  };

  // Keyed by tool name: the delivery endpoint only receives a task id, so it looks the handler up
  // from the name recorded on the task.
  const handlers = new Map<string, TaskHandler<never, TContext>>();
  const completedMessages = new Map<string, string>();
  const wired = new WeakSet<McpServer>();

  function registerTask<Schema extends StandardSchemaWithJSON>(
    server: McpServer,
    name: string,
    config: TaskToolConfig<Schema>,
    handler: TaskHandler<InferArgs<Schema>, TContext>,
  ): void {
    handlers.set(name, handler as TaskHandler<never, TContext>);
    if (config.completedMessage) completedMessages.set(name, config.completedMessage);
    registerSharedTools(server);

    const callback = async (args: unknown, context: unknown): Promise<Record<string, unknown>> => {
      const owner = callerOf(context);
      const key = config.idempotencyKey?.(args as InferArgs<Schema>);

      // A keyed call gets a deterministic id, so a retry lands on the task the first call made.
      // Scoped by owner and tool, so two callers' keys can never collide.
      const taskId = key === undefined ? randomUUID() : deterministicId(owner, name, key);
      if (key !== undefined) {
        const existing = await store.get(taskId);
        if (existing) return startedResult(existing, toolNames, true);
      }

      const now = new Date().toISOString();
      const task: Task = {
        taskId,
        status: "working",
        statusMessage: config.queuedMessage ?? "Queued for durable execution",
        createdAt: now,
        lastUpdatedAt: now,
        ttlMs: config.ttlMs ?? defaults.ttlMs ?? DEFAULT_TTL_MS,
        pollIntervalMs:
          config.pollIntervalMs ?? defaults.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        name,
        args,
        ...(owner !== undefined && { owner }),
      };

      // The record must be durable before the handle goes out, because the model may poll it
      // against another instance the moment it has the id. Dispatch second, so a queue that
      // accepts a task can always find its record. Two racing keyed calls both get here at
      // worst: they write the same record, and the dispatchers dedupe on the task id.
      await store.create(task);
      const dispatchId = await dispatcher.dispatch(task.taskId);
      const saved = dispatchId ? await store.update(task.taskId, { dispatchId }) : task;
      return startedResult(saved, toolNames, false);
    };

    server.registerTool(
      name,
      {
        title: config.title,
        description:
          `${config.description.trim()} Runs in the background: returns a taskId immediately. ` +
          `Call ${toolNames.status} with it to get progress and, once completed, the result.`,
        inputSchema: config.inputSchema,
      },
      callback as never,
    );
  }

  /** Registers `task_status` and `task_cancel` on a server, once. */
  function registerSharedTools(server: McpServer): void {
    if (wired.has(server)) return;
    wired.add(server);
    const inputSchema = z.object({
      taskId: z.string().describe("The taskId returned when the task was started."),
    });

    server.registerTool(
      toolNames.status,
      {
        title: "Task status",
        description:
          "Returns the status of a background task: working, completed, failed or cancelled. " +
          "While it is working, wait the suggested pollIntervalMs and call again — do not start " +
          "the task a second time. Once completed, the response contains the task's result.",
        inputSchema,
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      (async ({ taskId }: { taskId: string }, context: unknown) => {
        const task = await owned(taskId, context);
        return task ? statusResult(task) : unknownTaskResult(taskId);
      }) as never,
    );

    server.registerTool(
      toolNames.cancel,
      {
        title: "Cancel task",
        description:
          "Asks a background task to stop. Cancellation is cooperative: the task stops at its " +
          "next checkpoint. Cancelling a finished task changes nothing.",
        inputSchema,
        annotations: { destructiveHint: true, idempotentHint: true },
      },
      (async ({ taskId }: { taskId: string }, context: unknown) => {
        if (!(await owned(taskId, context))) return unknownTaskResult(taskId);
        const task = await cancelTask(taskId);
        return task ? statusResult(task) : unknownTaskResult(taskId);
      }) as never,
    );
  }

  async function cancelTask(taskId: string): Promise<Task | null> {
    const task = await read(taskId);
    if (!task) return null;
    // Two writes, on purpose. Flipping the status is the terminal, idempotent half — `settle`
    // returns null when the task was already terminal, which makes a repeated cancel a no-op
    // rather than a state change. Cancelling the dispatch is the other half: without it a pending
    // retry would re-invoke the executor on a task that is already finished.
    const settled = await store.settle(taskId, {
      status: "cancelled",
      statusMessage: "Cancelled by client",
    });
    const dispatchId = settled?.dispatchId ?? task.dispatchId;
    if (dispatchId) {
      // A message already in flight cannot be recalled; that is why cancellation is cooperative,
      // and why the handler still checks `isCancelled()`.
      await dispatcher.cancel(dispatchId).catch(() => undefined);
    }
    return settled ?? (await read(taskId));
  }

  async function executeTask(
    taskId: string,
    context?: TContext,
    journal?: TaskJournal,
  ): Promise<Task | null> {
    const task = await read(taskId);
    // Expired, or never existed: nothing to run, and nothing a retry could fix.
    if (!task) return null;

    // The redelivery guard. Delivery is at-least-once by contract, so the same task id can arrive
    // twice — after a cancel, or after a retry of a delivery that actually succeeded.
    if (isTerminal(task.status)) return task;

    const handler = handlers.get(task.name);
    if (!handler) {
      throw new Error(
        `No task handler registered for "${task.name}". Register it on every instance that serves the execute endpoint.`,
      );
    }

    // Journaled writes get a stable name from their call order, which is deterministic because a
    // replay re-runs the handler the same way up to the point it left off.
    let writes = 0;

    const taskContext: TaskContext = {
      taskId,
      update: async (statusMessage) => {
        const write = () => store.update(taskId, { statusMessage }).then(() => undefined);
        // Without a journal this is a plain write that repeats on every replay — harmless on a
        // queue, which never replays.
        await (journal ? journal(`mcp-task:update:${++writes}`, write) : write());
      },
      isCancelled: async () => {
        const current = await store.get(taskId);
        // A task that expired out from under us is not worth finishing either.
        return current === null || current.status === "cancelled";
      },
    };

    // A throw propagates untouched, leaving the task non-terminal on purpose: the dispatcher
    // decides whether that was a retry or a failure. Nothing is recorded here either, because the
    // core cannot tell a real error from a workflow engine suspending the handler mid-step — and
    // writing "attempt failed" for the latter would spray noise over a perfectly healthy run.
    const result = await (handler as TaskHandler<unknown, TContext>)(
      task.args,
      mergeContext(taskContext, context),
    );

    // If a cancel landed while the handler was running, `settle` refuses the transition and
    // returns null — the cancelled status wins, with no check-then-write race of our own.
    const settled = await store.settle(taskId, {
      status: "completed",
      statusMessage: completedMessages.get(task.name) ?? "Completed",
      result,
    });
    return settled ?? (await store.get(taskId));
  }

  async function failTask(taskId: string, error: TaskError): Promise<Task | null> {
    return await store.settle(taskId, {
      status: "failed",
      statusMessage: "Execution failed",
      error,
    });
  }

  /** Reads a task, folding "unknown" and "expired" into null. */
  async function read(taskId: string): Promise<Task | null> {
    try {
      return await store.get(taskId);
    } catch (cause) {
      if (cause instanceof UnknownTaskError) return null;
      throw cause;
    }
  }

  /**
   * Reads a task the caller is allowed to see. A task owned by someone else is reported as
   * unknown rather than forbidden, so an id cannot be probed for existence.
   */
  async function owned(taskId: string, context: unknown): Promise<Task | null> {
    const task = await read(taskId);
    if (!task) return null;
    if (task.owner === undefined || task.owner === null) return task;
    // Compared as strings: Redis' auto-deserialization turns a numeric-looking owner into a number.
    return String(task.owner) === callerOf(context) ? task : null;
  }

  function callerOf(context: unknown): string | undefined {
    if (!principal) return undefined;
    const auth = (context as { http?: { authInfo?: CallerAuth } } | undefined)?.http?.authInfo;
    return principal(auth);
  }

  function createExecuteHandler(): (request: Request) => Promise<Response> {
    if (!dispatcher.createExecuteHandler) {
      throw new Error(
        "This dispatcher has no delivery endpoint to serve — it runs tasks in the current " +
          "process. Use a transport-backed dispatcher (e.g. QStashDispatcher) to expose one.",
      );
    }
    return dispatcher.createExecuteHandler();
  }

  // Hand the transport its way back in, now that both halves exist.
  dispatcher.attach?.({ run: executeTask, fail: failTask });

  return {
    registerTask,
    executeTask,
    failTask,
    createExecuteHandler,
    getTask: read,
    cancelTask,
    store,
    dispatcher,
  };
}

/** What the starting tool answers: the handle, and a sentence telling the model what to do next. */
function startedResult(
  task: Task,
  toolNames: { status: string },
  deduplicated: boolean,
): Record<string, unknown> {
  const wire = toWire(task);
  const lead = deduplicated
    ? `Task ${task.taskId} already exists for this request (status: ${task.status}).`
    : `Started task ${task.taskId}.`;
  return {
    content: [
      {
        type: "text",
        text:
          `${lead} Call ${toolNames.status} with taskId "${task.taskId}" ` +
          `in about ${seconds(task.pollIntervalMs)} to check on it.`,
      },
    ],
    structuredContent: wire,
  };
}

/**
 * What `task_status` and `task_cancel` answer. A completed task hands back its own result's
 * `content`, so the model reads the answer exactly as if the tool had run synchronously.
 */
function statusResult(task: Task): Record<string, unknown> {
  const wire = toWire(task);
  const line = `Task ${task.taskId} is ${task.status}${task.statusMessage ? `: ${task.statusMessage}` : "."}`;

  if (task.status === "completed") {
    const content = Array.isArray(task.result?.content) ? task.result.content : [];
    return { content: [{ type: "text", text: line }, ...content], structuredContent: wire };
  }
  if (task.status === "failed") {
    return {
      content: [{ type: "text", text: `${line} Error: ${task.error?.message ?? "unknown"}` }],
      structuredContent: wire,
    };
  }
  const hint =
    task.status === "working" ? ` Check again in about ${seconds(task.pollIntervalMs)}.` : "";
  return { content: [{ type: "text", text: line + hint }], structuredContent: wire };
}

function unknownTaskResult(taskId: string): Record<string, unknown> {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Unknown task: ${taskId}. It may have expired, or the id may be wrong.`,
      },
    ],
  };
}

const seconds = (ms: number | undefined) =>
  `${Math.max(1, Math.round((ms ?? DEFAULT_POLL_INTERVAL_MS) / 1000))}s`;

/** A stable, opaque task id for an idempotency key. */
function deterministicId(owner: string | undefined, tool: string, key: string): string {
  return createHash("sha256")
    .update(JSON.stringify([owner ?? null, tool, key]))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Merges the task context into whatever the transport supplied, as one object.
 *
 * The transport's context is *mutated* rather than copied, and deliberately: a `WorkflowContext`
 * is a class instance whose `run`/`sleep`/`call` live on the prototype, so spreading it would drop
 * every method, and re-parenting it with `Object.create` would break `this` for anything the
 * engine keeps private. Assigning onto the instance keeps it intact — the object is ours for the
 * duration of one invocation anyway.
 */
function mergeContext<TContext>(
  taskContext: TaskContext,
  supplied: TContext | undefined,
): TaskContext & TContext {
  if (supplied === undefined || supplied === null) return taskContext as TaskContext & TContext;
  return Object.assign(supplied as object, taskContext) as TaskContext & TContext;
}

/** Strips the server-only fields, leaving what the model sees in `structuredContent`. */
export function toWire(task: Task): WireTask {
  const { name: _name, args: _args, dispatchId: _dispatchId, owner: _owner, ...wire } = task;
  return wire;
}
