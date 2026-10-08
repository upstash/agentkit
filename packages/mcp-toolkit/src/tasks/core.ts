/**
 * The tasks runtime: long-running work served as ordinary MCP tools. A task tool answers at once
 * with a task id; the shared `task_status` and `task_cancel` tools poll and stop it. The README
 * explains why tools rather than the Tasks extension.
 */
import type { McpServer, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import * as z from "zod";
import {
  callerOf,
  requirePrincipal,
  resolvePrincipal,
  type PrincipalResolver,
} from "../shared/auth.js";
import { INTERNAL_ERROR } from "../shared/env.js";
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

export type TaskLayerOptions<TContext = unknown> = {
  store: TaskStore;
  dispatcher: TaskDispatcher<TContext>;
  /**
   * Who is calling, usually your user id from `auth`. Required, and it must return an id: throw
   * when it can't, and the call is refused as not authenticated. Every task is owned by its
   * caller. `auth.clientId` is the OAuth app (shared by every ChatGPT user), so it is the wrong
   * key. A server with no users of its own passes `() => "local"`.
   */
  principal: PrincipalResolver;
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
  /** Adds every defined task tool, plus `task_status` and `task_cancel`, to a server. */
  register(server: McpServer): void;
  /** The dispatcher's delivery endpoint: `export const POST = tasks.createExecuteHandler()`. */
  createExecuteHandler(): (request: Request) => Promise<Response>;
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
  const { store, dispatcher } = options;
  const principal = requirePrincipal(options.principal, "createTaskLayer");
  const ttlMs = options.defaults?.ttlMs ?? DEFAULT_TTL_MS;
  const pollIntervalMs = options.defaults?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  // Keyed by tool name: a delivery only carries a task id, and the record names its tool.
  const definitions = new Map<
    string,
    { config: TaskToolConfig<StandardSchemaWithJSON>; handler: TaskHandler<unknown, TContext> }
  >();

  const callerId = (context: unknown) => resolvePrincipal(principal, callerOf(context));

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
        if (!(await owned(taskId, caller))) return errorResult(unknownTask(taskId));
        const task = await store.settle(taskId, {
          status: "cancelled",
          statusMessage: "Cancelled by client",
        });
        if (!task) return errorResult(unknownTask(taskId));
        // Also stop pending redeliveries. A delivery already running can't be recalled, which is
        // why handlers check `isCancelled()`.
        if (task.status === "cancelled") await dispatcher.cancel(taskId).catch(() => undefined);
        return statusResult(task);
      }) as never,
    );
  }

  async function startTask(name: string, args: unknown, context: unknown) {
    const owner = await callerId(context);
    if (!owner) return errorResult(NOT_AUTHENTICATED);
    const now = new Date().toISOString();
    const task: Task = {
      taskId: crypto.randomUUID(),
      status: "working",
      statusMessage: "Queued for durable execution",
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
      throw error;
    }
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
      update: async (statusMessage) => {
        const write = () => store.update(taskId, { statusMessage });
        await (journal ? journal(`mcp-task:update:${++writes}`, write) : write());
      },
      isCancelled: async () => (await store.get(taskId))?.status !== "working",
    };

    const result = await definition.handler(task.args, mergeContext(taskContext, context));
    // A cancel that landed meanwhile wins: settle refuses the second terminal write.
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

  return {
    define,
    register,
    createExecuteHandler: () => dispatcher.createExecuteHandler({ run, fail }),
  };
}

const NOT_AUTHENTICATED = "Not authenticated: this server could not identify the caller.";

const unknownTask = (taskId: string) =>
  `Unknown task: ${taskId}. It may have expired, or the id may be wrong.`;

function errorResult(text: string): Record<string, unknown> {
  return { isError: true, content: [{ type: "text", text }] };
}

/** A status line, followed by the task's own result content once it completed. */
function statusResult(task: Task): Record<string, unknown> {
  const line = `Task ${task.taskId} is ${task.status}${task.statusMessage ? `: ${task.statusMessage}` : "."}`;
  const extra =
    task.status === "completed" && Array.isArray(task.result?.content) ? task.result.content : [];
  const text =
    task.status === "failed"
      ? `${line} Error: ${task.error?.message ?? "unknown"}`
      : task.status === "working"
        ? `${line} Check again in about ${seconds(task.pollIntervalMs)}.`
        : line;
  return { content: [{ type: "text", text }, ...extra], structuredContent: toWire(task) };
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

/** Strips the server-only fields, leaving what the model sees in `structuredContent`. */
function toWire(task: Task): WireTask {
  const { name: _name, args: _args, owner: _owner, ...wire } = task;
  return wire;
}
