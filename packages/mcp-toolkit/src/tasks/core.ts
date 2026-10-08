/**
 * The tasks runtime: long-running work served as ordinary MCP tools. A task tool answers at once
 * with a task id; the shared `task_status` and `task_cancel` tools poll and stop it. The README
 * explains why tools rather than the Tasks extension.
 */
import type { McpServer, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import * as z from "zod";
import {
  callerOf as callerFrom,
  type Caller,
  requirePrincipal,
  resolvePrincipal,
  type CallerAuth,
  type PrincipalResolver,
} from "../shared/auth.js";
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
/** JSON-RPC internal error. */
const INTERNAL_ERROR = -32603;

/** The names the two shared tools are registered under, unless overridden. */
export const DEFAULT_TOOL_NAMES = { status: "task_status", cancel: "task_cancel" } as const;

export type { Caller, CallerAuth };

export type TaskLayerOptions<TContext = unknown> = {
  store: TaskStore;
  dispatcher: TaskDispatcher<TContext>;
  defaults?: {
    /** Retention window from creation. `null` means unlimited. Defaults to 5 minutes. */
    ttlMs?: number | null;
    /** Poll interval suggested to the model. Defaults to 2s. */
    pollIntervalMs?: number;
  };
  /**
   * Who is calling, usually your user id from `auth`. Required, and it must return an id: throw
   * when it can't, and the call is refused as not authenticated. Every task is owned by its caller. `auth.clientId` is the OAuth app
   * (shared by every ChatGPT user), so it is the wrong key. A server with no users of its own
   * passes `() => "local"`.
   */
  principal: PrincipalResolver;
  /** Renames the shared tools, e.g. to namespace them. */
  toolNames?: { status?: string; cancel?: string };
  /**
   * Called once per task, by the write that made it terminal. Throws are logged and swallowed.
   * `taskFinishedEvent(...).onSettle` from `@upstash/mcp-toolkit/events` plugs in here.
   */
  onSettle?: (task: Task) => void | Promise<void>;
};

export type TaskToolConfig<Schema extends StandardSchemaWithJSON> = {
  title?: string;
  /** What the tool does. The layer appends a sentence about polling `task_status`. */
  description: string;
  /** A Standard Schema (Zod 4, ArkType, Valibot) for the arguments. */
  inputSchema: Schema;
  /** Retention window for this tool's tasks. `null` means unlimited. */
  ttlMs?: number | null;
  pollIntervalMs?: number;
  /** Status message at creation. Defaults to `"Queued for durable execution"`. */
  queuedMessage?: string;
  /** Status message on success. Defaults to `"Completed"`. */
  completedMessage?: string;
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

export type TaskDefinition = { readonly name: string };

export type TaskLayer<TContext = unknown> = {
  /** Declares a task tool and its handler. Call it at module scope, so every instance has it. */
  define<Schema extends StandardSchemaWithJSON>(
    name: string,
    config: TaskToolConfig<Schema>,
    handler: TaskHandler<InferArgs<Schema>, TContext>,
  ): TaskDefinition;
  /** Adds every defined task tool, plus `task_status` and `task_cancel`, to a server. */
  register(server: McpServer): void;
  /** The dispatcher's delivery endpoint: `export const POST = tasks.createExecuteHandler()`. */
  createExecuteHandler(): (request: Request) => Promise<Response>;
  /** Reads a task server-side, without an ownership check. */
  getTask(taskId: string): Promise<Task | null>;
  /** Cancels a task server-side, without an ownership check. Idempotent. */
  cancelTask(taskId: string): Promise<Task | null>;
};

/**
 * Builds a tasks runtime over a store and a dispatcher.
 *
 * ```ts
 * export const tasks = createTaskLayer({ store, dispatcher, principal });
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
  const { store, dispatcher, defaults = {}, onSettle } = options;
  const principal = requirePrincipal(options.principal, "createTaskLayer");
  const toolNames = {
    status: options.toolNames?.status ?? DEFAULT_TOOL_NAMES.status,
    cancel: options.toolNames?.cancel ?? DEFAULT_TOOL_NAMES.cancel,
  };
  // Keyed by tool name: a delivery only carries a task id, and the record names its tool.
  const definitions = new Map<
    string,
    { config: TaskToolConfig<StandardSchemaWithJSON>; handler: TaskHandler<never, TContext> }
  >();
  const wired = new WeakSet<McpServer>();

  const callerOf = async (context: unknown) =>
    (await resolvePrincipal(principal, callerFrom(context)))?.id;

  async function runSettleHook(task: Task): Promise<void> {
    if (!onSettle) return;
    try {
      await onSettle(task);
    } catch (error) {
      console.warn(`[mcp-toolkit] onSettle failed for task ${task.taskId}:`, error);
    }
  }

  async function settle(taskId: string, patch: Parameters<TaskStore["settle"]>[1]) {
    const outcome = await store.settle(taskId, patch);
    if (outcome?.settled) await runSettleHook(outcome.task);
    return outcome;
  }

  function define<Schema extends StandardSchemaWithJSON>(
    name: string,
    config: TaskToolConfig<Schema>,
    handler: TaskHandler<InferArgs<Schema>, TContext>,
  ): TaskDefinition {
    if (name === toolNames.status || name === toolNames.cancel) {
      throw new Error(`"${name}" is reserved for the shared task tools`);
    }
    if (definitions.has(name)) throw new Error(`Task "${name}" is already defined`);
    definitions.set(name, {
      config: config as unknown as TaskToolConfig<StandardSchemaWithJSON>,
      handler: handler as TaskHandler<never, TContext>,
    });
    return { name };
  }

  function register(server: McpServer): void {
    if (wired.has(server)) return;
    wired.add(server);
    for (const [name, { config }] of definitions) registerTaskTool(server, name, config);
    registerSharedTools(server);
  }

  function registerTaskTool(
    server: McpServer,
    name: string,
    config: TaskToolConfig<StandardSchemaWithJSON>,
  ): void {
    const callback = async (args: unknown, context: unknown): Promise<Record<string, unknown>> => {
      const owner = await callerOf(context);
      if (!owner) return notAuthenticatedResult();
      const taskId = crypto.randomUUID();
      const now = new Date().toISOString();
      const task: Task = {
        taskId,
        status: "working",
        statusMessage: config.queuedMessage ?? "Queued for durable execution",
        createdAt: now,
        lastUpdatedAt: now,
        // `null` means unlimited, so `??` would wrongly replace it.
        ttlMs:
          config.ttlMs !== undefined
            ? config.ttlMs
            : defaults.ttlMs !== undefined
              ? defaults.ttlMs
              : DEFAULT_TTL_MS,
        pollIntervalMs:
          config.pollIntervalMs ?? defaults.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        name,
        args,
        owner,
      };

      // The record is durable before the id goes out, and before the work is queued.
      if (await store.create(task)) throw new Error(`Task id ${taskId} is already taken`);
      let dispatchId: string | undefined;
      try {
        dispatchId = await dispatcher.dispatch(task);
      } catch (error) {
        // Nothing will ever run this record: fail it rather than leave it `working` until its TTL.
        await settle(taskId, {
          status: "failed",
          statusMessage: "Could not be queued",
          error: { code: INTERNAL_ERROR, message: "The task could not be dispatched" },
        }).catch(() => undefined);
        throw error;
      }
      const saved = dispatchId ? await store.update(taskId, { dispatchId }) : task;
      return startedResult(saved, toolNames);
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

  function registerSharedTools(server: McpServer): void {
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
        const caller = await callerOf(context);
        if (!caller) return notAuthenticatedResult();
        const task = await owned(taskId, caller);
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
        const caller = await callerOf(context);
        if (!caller) return notAuthenticatedResult();
        if (!(await owned(taskId, caller))) return unknownTaskResult(taskId);
        const task = await cancelTask(taskId);
        return task ? statusResult(task) : unknownTaskResult(taskId);
      }) as never,
    );
  }

  async function cancelTask(taskId: string): Promise<Task | null> {
    const outcome = await settle(taskId, {
      status: "cancelled",
      statusMessage: "Cancelled by client",
    });
    if (!outcome) return null;
    // Also stop pending redeliveries. A delivery already running can't be recalled, which is why
    // handlers check `isCancelled()`.
    if (outcome.settled && outcome.task.dispatchId) {
      await dispatcher.cancel(outcome.task.dispatchId).catch(() => undefined);
    }
    return outcome.task;
  }

  /**
   * Runs a delivered task. A throw propagates and leaves the task `working`: only the transport
   * knows whether it will deliver again, so only it records the final failure.
   */
  async function executeTask(taskId: string, context?: TContext, journal?: TaskJournal) {
    const task = await read(taskId);
    // Expired or unknown, or a redelivery of a finished task: nothing to do.
    if (!task || isTerminal(task.status)) return;
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
      update: async (statusMessage) => {
        const write = () => store.update(taskId, { statusMessage }).then(() => undefined);
        await (journal ? journal(`mcp-task:update:${++writes}`, write) : write());
      },
      isCancelled: async () => {
        const current = await store.get(taskId);
        return current === null || current.status === "cancelled";
      },
    };

    const result = await (definition.handler as TaskHandler<unknown, TContext>)(
      task.args,
      mergeContext(taskContext, context),
    );
    // A cancel that landed meanwhile wins: settle refuses the second terminal write.
    await settle(taskId, {
      status: "completed",
      statusMessage: definition.config.completedMessage ?? "Completed",
      result,
    });
  }

  async function failTask(taskId: string, error: TaskError) {
    await settle(taskId, { status: "failed", statusMessage: "Execution failed", error });
  }

  /** Reads a task, folding a store's {@link UnknownTaskError} into null. */
  async function read(taskId: string): Promise<Task | null> {
    try {
      return await store.get(taskId);
    } catch (cause) {
      if (cause instanceof UnknownTaskError) return null;
      throw cause;
    }
  }

  /** Another caller's task reads as unknown, so ids cannot be probed. */
  async function owned(taskId: string, caller: string): Promise<Task | null> {
    const task = await read(taskId);
    return task && task.owner === caller ? task : null;
  }

  function createExecuteHandler(): (request: Request) => Promise<Response> {
    if (!dispatcher.createExecuteHandler) {
      throw new Error(
        "This dispatcher runs tasks in-process and has no delivery endpoint. Use QStashDispatcher or WorkflowDispatcher.",
      );
    }
    return dispatcher.createExecuteHandler();
  }

  dispatcher.attach?.({ run: executeTask, fail: failTask });

  return { define, register, createExecuteHandler, getTask: read, cancelTask };
}

function startedResult(task: Task, toolNames: { status: string }): Record<string, unknown> {
  const lead = `Started task ${task.taskId}.`;
  return {
    content: [
      {
        type: "text",
        text:
          `${lead} Call ${toolNames.status} with taskId "${task.taskId}" ` +
          `in about ${seconds(task.pollIntervalMs)} to check on it.`,
      },
    ],
    structuredContent: toWire(task),
  };
}

/** A status line, followed by the task's own result content once it completed. */
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

function notAuthenticatedResult(): Record<string, unknown> {
  return {
    isError: true,
    content: [
      { type: "text", text: "Not authenticated: this server could not identify the caller." },
    ],
  };
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

/** Strips the server-only fields, leaving what the model sees in `structuredContent`. */
export function toWire(task: Task): WireTask {
  const { name: _name, args: _args, dispatchId: _dispatchId, owner: _owner, ...wire } = task;
  return wire;
}
