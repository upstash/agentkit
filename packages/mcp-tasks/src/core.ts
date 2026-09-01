/**
 * The tasks runtime.
 *
 * The official TypeScript SDK ships the 2026-07-28 wire schemas for tasks but no runtime to back
 * them: v2 removed the v1 experimental task APIs and the migration guide says to drop the usages
 * rather than port them. What it does give us is the seam — the low-level `setRequestHandler`
 * takes a custom method plus your own schemas — so `tasks/get` and `tasks/cancel` can be added
 * without forking anything.
 *
 * {@link createTaskLayer} is that runtime, in one factory over a {@link TaskStore} and a
 * {@link TaskDispatcher}.
 */
import { randomUUID } from "node:crypto";
import {
  CLIENT_CAPABILITIES_META_KEY,
  ProtocolError,
  ProtocolErrorCode,
  type McpServer,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import * as z from "zod";
import {
  isTerminal,
  UnknownTaskError,
  type Task,
  type TaskContext,
  type TaskDispatcher,
  type TaskStore,
  type WireTask,
} from "./types.js";

/** The extension this runtime implements. */
export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

/** The protocol revision that carries per-request capabilities and the tasks extension. */
export const TASKS_PROTOCOL_VERSION = "2026-07-28";

const DEFAULT_TTL_MS = 300_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** What to do when a client calls a task tool without declaring the tasks extension. */
export type MissingCapabilityBehavior =
  /**
   * Answer with a tool error naming the capability the client has to declare, carrying `-32021`
   * and the required capabilities in `structuredContent`. The default.
   */
  | "error"
  /**
   * Run the handler inline and answer with its result, as an ordinary tool call. Spec-legal — the
   * server chooses per call whether to return a handle — but it re-introduces exactly the blocking
   * request that tasks exist to avoid, so it only suits work that is merely slow, not long.
   */
  | "run-inline";

export type TaskLayerOptions = {
  /** Durable storage for the task record. */
  store: TaskStore;
  /** Durable transport for the work itself. */
  dispatcher: TaskDispatcher;
  /** Fallback values for tasks that do not set their own. */
  defaults?: {
    /** Retention window. `null` means unlimited. Defaults to 5 minutes. */
    ttlMs?: number | null;
    /** Suggested client poll interval. Defaults to 2s. */
    pollIntervalMs?: number;
  };
  /** How to answer a client that has not declared the extension. Defaults to `"error"`. */
  onMissingCapability?: MissingCapabilityBehavior;
  /**
   * The JSON-RPC method names to serve the task operations under. Defaults to the spec's
   * `tasks/get` and `tasks/cancel`.
   *
   * Override them only if you serve through `createMcpHandler`. See {@link TASK_METHODS} for why
   * the defaults cannot work there.
   */
  methods?: {
    get?: string;
    cancel?: string;
  };
};

/**
 * The spec method names, and the one deployment that cannot use them.
 *
 * `createMcpHandler` pins each request to the 2026-07-28 era from the client's envelope claim.
 * On that era the SDK's dispatch gate rejects `tasks/*` with `-32601` *before* looking up your
 * handler: those strings are claimed spec vocabulary (they are in the SDK's 2025 method registry)
 * and were dropped from the 2026 one, so they are neither dispatchable nor free-form. Verified
 * against the real handler — the registered handler never runs.
 *
 * Two ways out, both supported here:
 *
 * 1. Serve with `WebStandardStreamableHTTPServerTransport` (or `NodeStreamableHTTPServerTransport`)
 *    and `transport.handleRequest`. That path leaves the instance on the 2025 era, where
 *    `tasks/get` and `tasks/cancel` dispatch normally — the per-request `_meta` envelope is still
 *    lifted, so the capability check works exactly the same. This is what the demo does, and it is
 *    the default.
 * 2. Stay on `createMcpHandler` and pass `methods` to move the operations to a namespace of your
 *    own (`{ get: "upstash/tasks.get", cancel: "upstash/tasks.cancel" }`). Anything outside the
 *    SDK's two registries is treated as a consumer-owned extension method and dispatches
 *    unconditionally — at the cost of no longer being the spec's wire names.
 */
export const TASK_METHODS = { get: "tasks/get", cancel: "tasks/cancel" } as const;

export type TaskToolConfig<Schema extends StandardSchemaWithJSON> = {
  /** Human-readable title for `tools/list`. */
  title?: string;
  /** What the tool does, for the model. */
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
};

/** Infers a Standard Schema's parsed output type. */
type InferArgs<Schema extends StandardSchemaWithJSON> = Schema extends {
  readonly "~standard": { types?: { readonly output: infer Output } | undefined };
}
  ? Output
  : unknown;

export type TaskHandler<Args> = (args: Args, task: TaskContext) => Promise<Record<string, unknown>>;

export type ExecuteTaskOptions = {
  /**
   * Whether this is the dispatcher's last delivery attempt. Defaults to `true`.
   *
   * It decides what a thrown handler means. On the last attempt the task is settled `failed`,
   * which is terminal and final. Before then the task is deliberately *left* `working` and the
   * error rethrown, so the endpoint can answer non-2xx and the dispatcher can retry — settling
   * `failed` on the first error would make the task terminal and quietly turn every subsequent
   * redelivery into a no-op, which is the opposite of what retries are for.
   */
  isFinalAttempt?: boolean;
};

export type TaskLayer = {
  /** Registers a tool whose calls are answered with a task handle. */
  registerTask<Schema extends StandardSchemaWithJSON>(
    server: McpServer,
    name: string,
    config: TaskToolConfig<Schema>,
    handler: TaskHandler<InferArgs<Schema>>,
  ): void;
  /** Runs a dispatched task. Call this from the endpoint your dispatcher delivers to. */
  executeTask(taskId: string, options?: ExecuteTaskOptions): Promise<Task | null>;
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
  /** Reads a task record server-side, bypassing the protocol. */
  getTask(taskId: string): Promise<Task | null>;
  /** The store this layer was built on. */
  store: TaskStore;
  /** The dispatcher this layer was built on. */
  dispatcher: TaskDispatcher;
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
export function createTaskLayer(options: TaskLayerOptions): TaskLayer {
  const { store, dispatcher, defaults = {}, onMissingCapability = "error" } = options;
  const methods = {
    get: options.methods?.get ?? TASK_METHODS.get,
    cancel: options.methods?.cancel ?? TASK_METHODS.cancel,
  };

  // Keyed by tool name: the delivery endpoint only receives a task id, so it looks the handler up
  // from the name recorded on the task.
  const handlers = new Map<string, TaskHandler<never>>();
  const completedMessages = new Map<string, string>();
  const wired = new WeakSet<McpServer>();

  function registerTask<Schema extends StandardSchemaWithJSON>(
    server: McpServer,
    name: string,
    config: TaskToolConfig<Schema>,
    handler: TaskHandler<InferArgs<Schema>>,
  ): void {
    handlers.set(name, handler as TaskHandler<never>);
    if (config.completedMessage) completedMessages.set(name, config.completedMessage);
    wireTaskMethods(server);

    // The tool declares nothing task-specific: it is an ordinary MCP tool, and the decision to
    // answer with a handle is made per call, from the caller's capabilities.
    const callback = async (args: unknown, context: unknown): Promise<Record<string, unknown>> => {
      {
        if (!clientSupportsTasks(context)) {
          if (onMissingCapability === "error") return missingCapabilityResult(name);
          return await runInline(name, args);
        }

        const now = new Date().toISOString();
        const task: Task = {
          taskId: randomUUID(),
          status: "working",
          statusMessage: config.queuedMessage ?? "Queued for durable execution",
          createdAt: now,
          lastUpdatedAt: now,
          ttlMs: config.ttlMs ?? defaults.ttlMs ?? DEFAULT_TTL_MS,
          pollIntervalMs:
            config.pollIntervalMs ?? defaults.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
          name,
          args,
        };

        // The order is the spec's, not a preference: the record must be durable before the
        // handle goes out, because the client may `tasks/get` it against another instance the
        // moment it has the id. Dispatch second, so a queue that accepts a task can always find
        // its record.
        await store.create(task);
        const dispatchId = await dispatcher.dispatch(task.taskId);
        const saved = dispatchId ? await store.update(task.taskId, { dispatchId }) : task;

        // The SDK's own result types strip `resultType` (it is wire-only), so the discriminator
        // has to be asserted past them. The transport does emit it — verified end to end.
        return { resultType: "task", ...toWire(saved) };
      }
    };

    server.registerTool(
      name,
      { title: config.title, description: config.description, inputSchema: config.inputSchema },
      callback as never,
    );
  }

  /**
   * Adds the extension's request methods to a server, once. `tasks/update` is deliberately absent:
   * it answers an `input_required` task, and this runtime has no way for a handler to ask for
   * input yet. It would be the same shape — write the client's answer into the record, let the
   * handler read it at a step boundary, exactly as it reads the cancelled status.
   */
  function wireTaskMethods(server: McpServer): void {
    if (wired.has(server)) return;
    wired.add(server);

    server.server.registerCapabilities({ extensions: { [TASKS_EXTENSION]: {} } });
    const params = z.object({ taskId: z.string() });

    server.server.setRequestHandler(methods.get, { params }, async ({ taskId }) => ({
      resultType: "complete",
      ...toWire(await required(taskId)),
    }));

    server.server.setRequestHandler(methods.cancel, { params }, async ({ taskId }) => {
      const task = await required(taskId);
      // Two writes, on purpose. Flipping the status is the terminal, idempotent half — `settle`
      // returns null when the task was already terminal, which makes a repeated cancel a no-op
      // rather than a state change. Cancelling the dispatch is the other half: without it a
      // pending retry would re-invoke the executor on a task that is already finished.
      const settled = await store.settle(taskId, {
        status: "cancelled",
        statusMessage: "Cancelled by client",
      });
      const dispatchId = settled?.dispatchId ?? task.dispatchId;
      if (dispatchId) {
        // A message already in flight cannot be recalled; that is why the spec calls
        // cancellation cooperative, and why the handler still checks `isCancelled()`.
        await dispatcher.cancel(dispatchId).catch(() => undefined);
      }
      return { resultType: "complete", ...toWire(settled ?? task) };
    });
  }

  async function executeTask(
    taskId: string,
    executeOptions: ExecuteTaskOptions = {},
  ): Promise<Task | null> {
    const { isFinalAttempt = true } = executeOptions;
    const task = await required(taskId);

    // The redelivery guard. Delivery is at-least-once by contract, so the same task id can arrive
    // twice — after a cancel, or after a retry of a delivery that actually succeeded.
    if (isTerminal(task.status)) return task;

    const handler = handlers.get(task.name);
    if (!handler) {
      throw new Error(
        `No task handler registered for "${task.name}". Register it on every instance that serves the execute endpoint.`,
      );
    }

    const context: TaskContext = {
      taskId,
      update: async (statusMessage) => {
        await store.update(taskId, { statusMessage });
      },
      isCancelled: async () => {
        const current = await store.get(taskId);
        // A task that expired out from under us is not worth finishing either.
        return current === null || current.status === "cancelled";
      },
    };

    try {
      const result = await (handler as TaskHandler<unknown>)(task.args, context);
      // If a cancel landed while the handler was running, `settle` refuses the transition and
      // returns null — the cancelled status wins, with no check-then-write race of our own.
      const settled = await store.settle(taskId, {
        status: "completed",
        statusMessage: completedMessages.get(task.name) ?? "Completed",
        result,
      });
      return settled ?? (await store.get(taskId));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (!isFinalAttempt) {
        // Stay non-terminal so the dispatcher's retry can still finish the work.
        await store
          .update(taskId, { statusMessage: `Attempt failed, retrying: ${message}` })
          .catch(() => undefined);
        throw cause;
      }
      await store.settle(taskId, {
        status: "failed",
        statusMessage: "Execution failed",
        error: { code: ProtocolErrorCode.InternalError, message },
      });
      throw cause;
    }
  }

  async function runInline(name: string, args: unknown): Promise<Record<string, unknown>> {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`No task handler registered for "${name}".`);
    return await (handler as TaskHandler<unknown>)(args, {
      taskId: "",
      update: async () => undefined,
      isCancelled: async () => false,
    });
  }

  async function required(taskId: string): Promise<Task> {
    let task: Task | null;
    try {
      task = await store.get(taskId);
    } catch (cause) {
      if (cause instanceof UnknownTaskError) task = null;
      else throw cause;
    }
    // An expired task is indistinguishable from one that never existed, which is the right
    // answer to give: the draft lets a server discard a task once its TTL elapses.
    if (!task) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown task: ${taskId}`);
    return task;
  }

  function createExecuteHandler(): (request: Request) => Promise<Response> {
    if (!dispatcher.createExecuteHandler) {
      throw new Error(
        "This dispatcher has no delivery endpoint to serve — it runs tasks in the current " +
          "process. Use a transport-backed dispatcher (e.g. QStashDispatcher) to expose one.",
      );
    }
    return dispatcher.createExecuteHandler((taskId, { isFinalAttempt }) =>
      executeTask(taskId, { isFinalAttempt }),
    );
  }

  return {
    registerTask,
    executeTask,
    createExecuteHandler,
    getTask: (taskId) => store.get(taskId),
    store,
    dispatcher,
  };
}

/**
 * The answer to a task tool called by a client that cannot handle a task handle.
 *
 * It is a tool *error result*, not a thrown error, because `McpServer` catches everything a tool
 * callback throws — `ProtocolError` included — and flattens it into `{ content, isError: true }`,
 * dropping the code on the way. Verified against the SDK: throwing
 * `MissingRequiredClientCapabilityError` reaches the client as an `isError` result whose `-32021`
 * is nowhere to be found. So the code and the capability the caller is missing are put in
 * `structuredContent`, where a client can actually read them.
 */
function missingCapabilityResult(toolName: string): Record<string, unknown> {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text:
          `"${toolName}" answers with a task handle, which requires the ` +
          `"${TASKS_EXTENSION}" client capability. Declare it in the request's ` +
          `_meta["${CLIENT_CAPABILITIES_META_KEY}"].extensions and call again.`,
      },
    ],
    structuredContent: {
      code: ProtocolErrorCode.MissingRequiredClientCapability,
      requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } },
    },
  };
}

/**
 * Reads the tasks capability off the per-request envelope.
 *
 * Statelessness is why this is not a session lookup: there is no initialize handshake to remember
 * what the client supports, so every request carries its own capabilities in `_meta` and the SDK
 * lifts them onto `ctx.mcpReq.envelope`.
 */
function clientSupportsTasks(context: unknown): boolean {
  const envelope = (context as { mcpReq?: { envelope?: Record<string, unknown> } } | undefined)
    ?.mcpReq?.envelope;
  const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY] as
    | { extensions?: Record<string, unknown> }
    | undefined;
  return Boolean(capabilities?.extensions && TASKS_EXTENSION in capabilities.extensions);
}

/** Strips the server-only fields, leaving exactly what the draft schema puts on the wire. */
export function toWire(task: Task): WireTask {
  const { name: _name, args: _args, dispatchId: _dispatchId, ...wire } = task;
  return wire;
}
