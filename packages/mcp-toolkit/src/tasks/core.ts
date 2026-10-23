/**
 * The tasks runtime: long-running tools. A task tool answers at once and the work runs behind the
 * dispatcher. A client that declares the `io.modelcontextprotocol/tasks` extension on the call gets
 * a native task (`resultType: "task"`, then `tasks/get` / `tasks/cancel`); any other client gets the
 * task id in an ordinary tool result and polls the shared `task_status` / `task_cancel` tools.
 */
import {
  ProtocolError,
  ProtocolErrorCode,
  type McpServer,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import * as z from "zod";
import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  callerOf,
  requirePrincipal,
  resolvePrincipal,
  type Caller,
  type PrincipalResolver,
} from "../shared/auth.js";
import { env, INTERNAL_ERROR } from "../shared/env.js";
import { InProcessDispatcher, MemoryTaskStore } from "./memory.js";
import type {
  Task,
  TaskContext,
  TaskDispatcher,
  TaskError,
  TaskJournal,
  TaskStore,
  WireTask,
} from "./types.js";

/** One day: long enough for slow work plus retries, and for the model to come back for the result. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const STATUS_TOOL = "task_status";
const CANCEL_TOOL = "task_cancel";
/** The MCP Tasks extension (protocol revision 2026-07-28). */
const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";

/**
 * How a task tool answers.
 *
 * - `"native"` (default): a call that declares the MCP Tasks extension gets a native task, polled
 *   with `tasks/get`; every other call gets the tool-based handle.
 * - `"tools"`: always the tool-based handle, as in 0.x: the task id in an ordinary tool result,
 *   polled with `task_status` and stopped with `task_cancel`. No `tasks/*` methods, and no
 *   extension in the server's capabilities.
 */
export type TaskMode = "native" | "tools";

/**
 * Where tasks are kept and how they run. Both omitted: in memory and in this process
 * ({@link MemoryTaskStore}, {@link InProcessDispatcher}), with no other service and no execute
 * endpoint, but nothing survives a restart and nothing is shared between instances, so a
 * serverless or multi-instance deployment needs a shared store and a durable dispatcher, e.g.
 * `RedisTaskStore` with `QStashDispatcher` or `WorkflowDispatcher`. A dispatcher always comes with
 * a store: one that delivers through an endpoint may run the task on another instance.
 */
export type TaskBackends<TContext = unknown> =
  | {
      /** Keeps the task records. Defaults to a {@link MemoryTaskStore}: lost on restart. */
      store: TaskStore;
      /** Runs the tasks. Defaults to an {@link InProcessDispatcher}: no retries, lost on exit. */
      dispatcher: TaskDispatcher<TContext>;
    }
  | {
      /** Keeps the task records. Defaults to a {@link MemoryTaskStore}: lost on restart. */
      store?: TaskStore;
      /** Runs the tasks. Defaults to an {@link InProcessDispatcher}: no retries, lost on exit. */
      dispatcher?: undefined;
    };

export type TaskLayerOptions<TContext = unknown> = TaskBackends<TContext> & {
  /**
   * Who is calling, usually your user id from `auth`. Required, and it must return an id: throw
   * when it can't, and the call is refused as not authenticated. Every task is owned by its
   * caller. `auth.clientId` is the OAuth app (shared by every ChatGPT user), so it is the wrong
   * key. A server with no users of its own passes `() => "local"`.
   */
  principal: PrincipalResolver;
  /**
   * `"native"` (default) answers clients that declare the MCP Tasks extension with native tasks
   * and everyone else with the tool-based handle; `"tools"` always uses the tool-based handle,
   * exactly as 0.x did. See {@link TaskMode}.
   */
  mode?: TaskMode;
  defaults?: {
    /** Retention window from creation. Defaults to 1 day. */
    ttlMs?: number;
    /** Poll interval suggested to the model. Defaults to 2s. */
    pollIntervalMs?: number;
  };
};

export type TaskToolConfig<Schema extends StandardSchemaWithJSON> = {
  title?: string;
  /** What the tool does. The layer appends a sentence about polling `task_status`. */
  description: string;
  /** A Standard Schema (Zod 4, ArkType, Valibot) for the arguments. */
  inputSchema: Schema;
  /** Status message on success. Defaults to `"Completed"`. */
  completedMessage?: string;
  /**
   * Whether this caller may start the task with these arguments, e.g. whether they can write to
   * the workspace the arguments name. Runs before anything is stored or queued; `false` refuses
   * the call. Optional: without it, any authenticated caller may start the task. The handler also
   * gets `task.principal`, for checks that belong in the work itself.
   */
  authorize?: (args: InferArgs<Schema>, caller: TaskAuthorizeCaller) => boolean | Promise<boolean>;
};

/** What a task's `authorize` is told about the caller. */
export type TaskAuthorizeCaller = {
  /** The caller's id, from `principal`. */
  principal: string;
  /** The verified `AuthInfo` your route passed to the SDK, if any. */
  auth: AuthInfo | undefined;
  /** The raw, unverified HTTP request. */
  request: Request | undefined;
};

type InferArgs<Schema extends StandardSchemaWithJSON> = Schema extends {
  readonly "~standard": { types?: { readonly output: infer Output } | undefined };
}
  ? Output
  : unknown;

/**
 * A task's implementation. The context is {@link TaskContext} plus whatever the dispatcher adds
 * (the live `WorkflowContext` on Workflow). Return an MCP tool result.
 */
export type TaskHandler<Args, TContext = unknown> = (
  args: Args,
  task: TaskContext & TContext,
) => Promise<Record<string, unknown>>;

export type TaskLayer<TContext = unknown> = {
  /** Declares a task tool and its handler. Call it at module scope, so every instance has it. */
  define<Schema extends StandardSchemaWithJSON>(
    name: string,
    config: TaskToolConfig<Schema>,
    handler: TaskHandler<InferArgs<Schema>, TContext>,
  ): void;
  /**
   * Adds every defined task tool, plus `task_status` and `task_cancel`, to a server. In native
   * mode it also advertises the Tasks extension and serves `tasks/get` and `tasks/cancel`. Call it
   * before the server is connected, e.g. inside the `createMcpHandler` factory.
   */
  register(server: McpServer): void;
  /** The dispatcher's delivery endpoint: `export const POST = tasks.createExecuteHandler()`. */
  createExecuteHandler(): (request: Request) => Promise<Response>;
};

/**
 * Builds a tasks runtime over a store and a dispatcher. Without them, tasks are kept in memory and
 * run in this process (see {@link TaskBackends}): fine for a single long-lived server, not for
 * serverless or several instances.
 *
 * ```ts
 * export const tasks = createTaskLayer({ principal: () => "local" });
 * tasks.define("generate_report", { description, inputSchema }, handler); // module scope
 *
 * export function createServer() {
 *   const server = new McpServer({ name: "reports", version: "1.0.0" });
 *   tasks.register(server);
 *   return server;
 * }
 * ```
 */
export function createTaskLayer<TContext = unknown>(
  options: TaskLayerOptions<TContext>,
): TaskLayer<TContext> {
  if (options.dispatcher && !options.store) {
    throw new Error(
      "createTaskLayer: pass a `store` with your `dispatcher`. The in-memory default would not " +
        "be shared with the instance that runs the task (use RedisTaskStore).",
    );
  }
  if (!options.dispatcher) warnInMemory(!options.store);
  const store = options.store ?? new MemoryTaskStore();
  const dispatcher = options.dispatcher ?? (new InProcessDispatcher() as TaskDispatcher<TContext>);
  const principal = requirePrincipal(options.principal, "createTaskLayer");
  const mode = options.mode ?? "native";
  if (mode !== "native" && mode !== "tools") {
    throw new Error('createTaskLayer: mode must be "native" or "tools"');
  }
  const ttlMs = positiveInteger(options.defaults?.ttlMs ?? DEFAULT_TTL_MS, "defaults.ttlMs");
  const pollIntervalMs = positiveInteger(
    options.defaults?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    "defaults.pollIntervalMs",
  );
  // Keyed by tool name: a delivery only carries a task id, and the record names its tool.
  const definitions = new Map<
    string,
    { config: TaskToolConfig<StandardSchemaWithJSON>; handler: TaskHandler<unknown, TContext> }
  >();

  const callerId = (context: unknown, caller: Caller = callerOf(context)) =>
    resolvePrincipal(principal, caller);

  function define<Schema extends StandardSchemaWithJSON>(
    name: string,
    config: TaskToolConfig<Schema>,
    handler: TaskHandler<InferArgs<Schema>, TContext>,
  ): void {
    if (name === STATUS_TOOL || name === CANCEL_TOOL) {
      throw new Error(`"${name}" is reserved for the shared task tools`);
    }
    if (definitions.has(name)) throw new Error(`Task "${name}" is already defined`);
    definitions.set(name, {
      config: config as unknown as TaskToolConfig<StandardSchemaWithJSON>,
      handler: handler as TaskHandler<unknown, TContext>,
    });
  }

  function register(server: McpServer): void {
    for (const [name, { config }] of definitions) {
      server.registerTool(
        name,
        {
          title: config.title,
          description:
            `${config.description.trim()} Runs in the background: returns a taskId immediately. ` +
            `Call ${STATUS_TOOL} with it to get progress and, once completed, the result.`,
          inputSchema: config.inputSchema,
        },
        (async (args: unknown, context: unknown) => startTask(name, args, context)) as never,
      );
    }

    const inputSchema = z.object({
      taskId: z.uuid().describe("The taskId returned when the task was started."),
    });

    server.registerTool(
      STATUS_TOOL,
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
        const caller = await callerId(context);
        if (!caller) return errorResult(NOT_AUTHENTICATED);
        const task = await owned(taskId, caller);
        return task ? statusResult(task) : errorResult(unknownTask(taskId));
      }) as never,
    );

    server.registerTool(
      CANCEL_TOOL,
      {
        title: "Cancel task",
        description:
          "Asks a background task to stop. Cancellation is cooperative: the task stops at its " +
          "next checkpoint. Cancelling a finished task changes nothing.",
        inputSchema,
        annotations: { destructiveHint: true, idempotentHint: true },
      },
      (async ({ taskId }: { taskId: string }, context: unknown) => {
        const caller = await callerId(context);
        if (!caller) return errorResult(NOT_AUTHENTICATED);
        const task = await cancelOwned(taskId, caller);
        return task ? statusResult(task) : errorResult(unknownTask(taskId));
      }) as never,
    );

    if (mode === "native") registerNative(server);
  }

  /**
   * The Tasks extension's server side, through the SDK's own extension points: the capability on
   * `server/discover`, and the two methods Claude Code calls. `tasks/update` (input_required),
   * `tasks/list` and `tasks/result` are not served, so the SDK answers them "Method not found".
   */
  function registerNative(server: McpServer): void {
    server.server.registerCapabilities({ extensions: { [TASKS_EXTENSION]: {} } });
    // Any string: a malformed id reads exactly like a missing or foreign one (-32602), and never
    // reaches the store.
    const params = z.object({ taskId: z.string() });

    server.server.setRequestHandler("tasks/get", { params }, async ({ taskId }, context) => {
      const caller = await callerId(context);
      const task = caller && isTaskId(taskId) ? await owned(taskId, caller) : null;
      if (!task) throw unknownTaskError(taskId);
      return nativeDetail(task);
    });

    server.server.setRequestHandler("tasks/cancel", { params }, async ({ taskId }, context) => {
      const caller = await callerId(context);
      const task = caller && isTaskId(taskId) ? await cancelOwned(taskId, caller) : null;
      if (!task) throw unknownTaskError(taskId);
      return { resultType: "complete" };
    });
  }

  /** Cancels the caller's task and returns it; `null` when it is unknown or not theirs. */
  async function cancelOwned(taskId: string, caller: string): Promise<Task | null> {
    if (!(await owned(taskId, caller))) return null;
    const task = await store.settle(taskId, {
      status: "cancelled",
      statusMessage: "Cancelled by client",
    });
    // Also stop pending redeliveries. A delivery already running can't be recalled, which is
    // why handlers check `isCancelled()`.
    if (task?.status === "cancelled") await dispatcher.cancel(taskId).catch(() => undefined);
    return task;
  }

  async function startTask(name: string, args: unknown, context: unknown) {
    const caller = callerOf(context);
    const owner = await callerId(context, caller);
    if (!owner) return errorResult(NOT_AUTHENTICATED);
    const authorize = definitions.get(name)?.config.authorize;
    if (authorize && !(await authorize(args, { principal: owner, ...caller }))) {
      return errorResult(NOT_AUTHORIZED);
    }
    const now = new Date().toISOString();
    const task: Task = {
      taskId: crypto.randomUUID(),
      status: "working",
      statusMessage: "Queued",
      createdAt: now,
      lastUpdatedAt: now,
      ttlMs,
      pollIntervalMs,
      name,
      args,
      owner,
    };
    // The record is durable before the id goes out, and before the work is queued.
    await store.create(task);
    try {
      await dispatcher.dispatch(task);
    } catch (error) {
      // Nothing will ever run this record: fail it rather than leave it `working` until its TTL.
      await store
        .settle(task.taskId, {
          status: "failed",
          statusMessage: "Could not be queued",
          error: { code: INTERNAL_ERROR, message: "The task could not be dispatched" },
        })
        .catch(() => undefined);
      // The transport's error (a QStash response, a URL) is for your logs, not the model.
      console.error(`[mcp-toolkit] could not dispatch task ${task.taskId}:`, error);
      return errorResult("The task could not be queued. Try again later.");
    }
    // A task only for a call that declared the extension on this very request: the extension
    // forbids returning one to a client that didn't, and Claude Code omits it on calls (from a
    // subagent, say) that cannot become a task.
    if (mode === "native" && declaresTasks(context)) return nativeHandle(task);
    return {
      content: [
        {
          type: "text",
          text:
            `Started task ${task.taskId}. Call ${STATUS_TOOL} with taskId "${task.taskId}" ` +
            `in about ${seconds(pollIntervalMs)} to check on it.`,
        },
      ],
      structuredContent: toWire(task),
    };
  }

  /**
   * Runs a delivered task. A throw propagates and leaves the task `working`: only the transport
   * knows whether it will deliver again, so only it records the final failure.
   */
  async function run(taskId: string, context: TContext, journal?: TaskJournal): Promise<void> {
    const task = await store.get(taskId);
    // Expired or unknown, or a redelivery of a finished task: nothing to do.
    if (!task || task.status !== "working") return;
    const definition = definitions.get(task.name);
    if (!definition) {
      throw new Error(
        `No task handler defined for "${task.name}". Call tasks.define(...) at module scope, in a module the execute route imports.`,
      );
    }

    // Journaled writes are named by call order, which a replay reproduces.
    let writes = 0;
    const taskContext: TaskContext = {
      taskId,
      principal: task.owner,
      update: async (statusMessage) => {
        const write = () => store.update(taskId, { statusMessage });
        await (journal ? journal(`mcp-task:update:${++writes}`, write) : write());
      },
      isCancelled: async () => (await store.get(taskId))?.status !== "working",
    };

    const result = await definition.handler(task.args, mergeContext(taskContext, context));
    // A cancel that landed meanwhile wins: settle refuses the second terminal write.
    if (result?.isError === true) {
      // The handler answered with a tool error, the way a synchronous tool would: the task failed,
      // and its own content explains why. Not retried: it returned, it didn't throw.
      await store.settle(taskId, {
        status: "failed",
        statusMessage: "Failed",
        result,
        error: { code: INTERNAL_ERROR, message: "The task returned an error" },
      });
      return;
    }
    await store.settle(taskId, {
      status: "completed",
      statusMessage: definition.config.completedMessage ?? "Completed",
      result,
    });
  }

  async function fail(taskId: string, error: TaskError): Promise<void> {
    await store.settle(taskId, { status: "failed", statusMessage: "Execution failed", error });
  }

  /** Another caller's task reads as unknown, so ids cannot be probed. */
  async function owned(taskId: string, caller: string): Promise<Task | null> {
    const task = await store.get(taskId);
    return task && task.owner === caller ? task : null;
  }

  const endpoints = { run, fail };
  dispatcher.connect?.(endpoints);

  return {
    define,
    register,
    createExecuteHandler: () => dispatcher.createExecuteHandler(endpoints),
  };
}

let warnedInMemory = false;

/**
 * Once per process, in production: the in-memory defaults lose tasks on restart and break on
 * serverless, where `tasks/get` may reach an instance that never saw the task. Passing the
 * backends explicitly (in-memory ones included) is the way to say this is intended.
 */
function warnInMemory(noStore: boolean): void {
  if (warnedInMemory || env("NODE_ENV") !== "production") return;
  warnedInMemory = true;
  console.warn(
    `[mcp-toolkit] createTaskLayer: no ${noStore ? "store or dispatcher" : "dispatcher"} given, so ` +
      `tasks ${noStore ? "are kept in memory and " : ""}run in this process. They are lost on ` +
      "restart and do not work across serverless invocations or several instances. Use " +
      "RedisTaskStore with QStashDispatcher or WorkflowDispatcher (the toolkit's /upstash entry), " +
      "or pass the in-memory backends explicitly to silence this.",
  );
}

const NOT_AUTHENTICATED = "Not authenticated: this server could not identify the caller.";
const NOT_AUTHORIZED = "Not authorized to start this task with these arguments.";

/** Validates a duration option: a positive, finite whole number of milliseconds. */
function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`createTaskLayer: ${name} must be a positive whole number of milliseconds`);
  }
  return value;
}

const unknownTask = (taskId: string) =>
  `Unknown task: ${taskId}. It may have expired, or the id may be wrong.`;

/** Task ids are random UUIDs; anything else is unknown before it reaches the store. */
const isTaskId = (taskId: string) => z.uuid().safeParse(taskId).success;

/**
 * The extension's "unknown task" answer (`-32602`), given alike for a missing, expired, malformed
 * or foreign id and for a caller `principal` refused, so ids cannot be probed.
 */
function unknownTaskError(taskId: string): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, unknownTask(taskId.slice(0, 128)));
}

/**
 * Whether the request declared the Tasks extension in its per-request client capabilities,
 * `_meta["io.modelcontextprotocol/clientCapabilities"].extensions` on protocol revision
 * 2026-07-28. The SDK lifts that envelope out of `_meta` into `ctx.mcpReq.envelope`.
 */
function declaresTasks(context: unknown): boolean {
  const envelope = (context as { mcpReq?: { envelope?: Record<string, unknown> } } | undefined)
    ?.mcpReq?.envelope;
  const capabilities = envelope?.[CLIENT_CAPABILITIES_KEY] as
    | { extensions?: Record<string, unknown> }
    | undefined;
  const declared = capabilities?.extensions?.[TASKS_EXTENSION];
  return typeof declared === "object" && declared !== null;
}

/** The extension's task fields, shared by the handle and `tasks/get`. */
function nativeTask(task: Task): Record<string, unknown> {
  return {
    taskId: task.taskId,
    status: task.status,
    ...(task.statusMessage !== undefined ? { statusMessage: task.statusMessage } : {}),
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttlMs: task.ttlMs,
    pollIntervalMs: task.pollIntervalMs,
  };
}

/**
 * The `tools/call` answer for a call that declared the extension: a task instead of a tool result.
 * The SDK passes a handler's own `resultType` through on `tools/call`.
 */
function nativeHandle(task: Task): Record<string, unknown> {
  return { resultType: "task", ...nativeTask(task) };
}

/**
 * The `tasks/get` answer. `completed` carries the tool result as-is. `failed` carries the JSON-RPC
 * error the extension requires, which is what Claude Code tells the model: for a handler that
 * returned `isError`, the message is that result's own text (what the synchronous tool would have
 * shown); for a transport failure, the stored code and message. `error.data` stays in the store,
 * as with `task_status`.
 */
function nativeDetail(task: Task): Record<string, unknown> {
  const detail: Record<string, unknown> = { resultType: "complete", ...nativeTask(task) };
  if (task.status === "completed") detail.result = task.result ?? { content: [] };
  if (task.status === "failed") {
    const handlerText = task.result?.isError === true ? textOf(task.result.content) : "";
    detail.error = {
      code: task.error?.code ?? INTERNAL_ERROR,
      message: handlerText || task.error?.message || task.statusMessage || "Task failed",
    };
  }
  return detail;
}

/** The text blocks of a tool result's content, joined by newlines. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        block?.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function errorResult(text: string): Record<string, unknown> {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * A status line, followed by the task's own result content once it completed, or once it failed by
 * returning a tool error. That last case also carries `isError`, as the synchronous tool would have.
 */
function statusResult(task: Task): Record<string, unknown> {
  const line = `Task ${task.taskId} is ${task.status}${task.statusMessage ? `: ${task.statusMessage}` : "."}`;
  const handlerError = task.status === "failed" && task.result?.isError === true;
  const extra =
    (task.status === "completed" || handlerError) && Array.isArray(task.result?.content)
      ? task.result.content
      : [];
  const text =
    task.status === "failed"
      ? `${line} Error: ${task.error?.message ?? "unknown"}`
      : task.status === "working"
        ? `${line} Check again in about ${seconds(task.pollIntervalMs)}.`
        : line;
  return {
    content: [{ type: "text", text }, ...extra],
    structuredContent: toWire(task),
    ...(handlerError ? { isError: true } : {}),
  };
}

const seconds = (ms: number) => `${Math.max(1, Math.round(ms / 1000))}s`;

/**
 * Merges the task context into the transport's, as one object. Assigned onto the instance rather
 * than spread: a `WorkflowContext` keeps its methods on the prototype.
 */
function mergeContext<TContext>(
  taskContext: TaskContext,
  supplied: TContext | undefined,
): TaskContext & TContext {
  if (supplied === undefined || supplied === null) return taskContext as TaskContext & TContext;
  return Object.assign(supplied as object, taskContext) as TaskContext & TContext;
}

/**
 * Strips the server-only fields, leaving what the model sees in `structuredContent`. That includes
 * `error.data`: transports put the failing response there (a stack trace, a database error), which
 * stays in the store for your logs.
 */
function toWire(task: Task): WireTask {
  const { name: _name, args: _args, owner: _owner, error, ...wire } = task;
  return error ? { ...wire, error: { code: error.code, message: error.message } } : wire;
}
