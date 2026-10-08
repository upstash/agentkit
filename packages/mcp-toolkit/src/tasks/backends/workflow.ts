/**
 * The Upstash Workflow dispatcher, for work longer than one function invocation: every
 * `task.run(...)` step is its own request, and a finished step is replayed from the journal.
 */
import type { Client as QStashClient, Receiver } from "@upstash/qstash";
import { Client as WorkflowClient, serve, type WorkflowContext } from "@upstash/workflow";
import { env, lazy, requireEnv, resolveQStash, resolveReceiver } from "../../shared/clients.js";
import { addQStashTelemetry } from "../../telemetry.js";
import { type Task, type TaskDispatcher, type TaskEndpoints, type TaskJournal } from "../types.js";

/** JSON-RPC internal error. */
const INTERNAL_ERROR = -32603;

export type WorkflowDispatcherConfig = {
  /** The public URL of the route serving `tasks.createExecuteHandler()`, reachable from QStash. */
  url: string;
  /** The Workflow client. Defaults to one from `QSTASH_TOKEN` (and `QSTASH_URL`). */
  client?: WorkflowClient;
  /** Extra headers to send when triggering a run. */
  headers?: Record<string, string>;
  /** Retries per step. Defaults to the Workflow SDK's default. */
  retries?: number;
  /**
   * Verifies every request to the endpoint. Defaults to one from the `QSTASH_*_SIGNING_KEY` env
   * vars. Required either way: Workflow itself skips verification when they are missing.
   */
  receiver?: Receiver;
  /** The QStash client the endpoint schedules steps with. Defaults to one from `QSTASH_TOKEN`. */
  qstash?: QStashClient;
  /** Set `false` to skip this package's tag in the telemetry header. */
  enableTelemetry?: boolean;
};

type WorkflowPayload = { taskId?: string };

/**
 * Runs each task as a Workflow run. Handlers get the live `WorkflowContext`, so `task.run`,
 * `task.sleep` and `task.call` are the real thing. Cancelling a task cancels the run.
 */
export class WorkflowDispatcher implements TaskDispatcher<WorkflowContext<WorkflowPayload>> {
  private readonly config: WorkflowDispatcherConfig;
  private readonly client: () => WorkflowClient;
  private readonly handler: () => (request: Request) => Promise<Response>;
  private endpoints: TaskEndpoints<WorkflowContext<WorkflowPayload>> | undefined;

  constructor(config: WorkflowDispatcherConfig) {
    this.config = config;
    this.client = lazy(() => {
      const client =
        config.client ??
        new WorkflowClient({
          token: requireEnv("WorkflowDispatcher", "QSTASH_TOKEN"),
          baseUrl: env("QSTASH_URL"),
        });
      addQStashTelemetry(client, { enabled: config.enableTelemetry ?? true });
      return client;
    });
    // Built on the first request: route modules are evaluated at build time, without the keys.
    this.handler = lazy(() => this.buildHandler());
  }

  attach(endpoints: TaskEndpoints<WorkflowContext<WorkflowPayload>>): void {
    this.endpoints = endpoints;
  }

  async dispatch(task: Task): Promise<string | undefined> {
    const { workflowRunId } = await this.client().trigger({
      url: this.config.url,
      body: { taskId: task.taskId } satisfies WorkflowPayload,
      headers: this.config.headers,
      retries: this.config.retries,
      // One run per task: Workflow refuses a run id that was already used.
      workflowRunId: task.taskId,
    });
    return workflowRunId;
  }

  async cancel(dispatchId: string): Promise<void> {
    await this.client().cancel(dispatchId);
  }

  /** The workflow endpoint. Its `failureFunction` settles the task `failed` once retries run out. */
  createExecuteHandler(): (request: Request) => Promise<Response> {
    return (request) => this.handler()(request);
  }

  private buildHandler(): (request: Request) => Promise<Response> {
    // Resolved here, so a missing key throws instead of serving unverified.
    const receiver = resolveReceiver("WorkflowDispatcher", this.config.receiver);
    const qstashClient = resolveQStash(
      "WorkflowDispatcher",
      this.config.qstash,
      this.config.enableTelemetry,
    );
    const { handler } = serve<WorkflowPayload>(
      async (context) => {
        const taskId = context.requestPayload?.taskId;
        if (taskId) await this.required().run(taskId, context, journalFor(context));
      },
      {
        failureFunction: async ({ context, failStatus, failResponse }) => {
          const taskId = (context.requestPayload as WorkflowPayload | undefined)?.taskId;
          if (!taskId) return;
          await this.required().fail(taskId, {
            code: INTERNAL_ERROR,
            message: `Workflow run failed${failStatus ? ` (status ${failStatus})` : ""}`,
            data: { response: failResponse, workflowRunId: context.workflowRunId },
          });
        },
        receiver,
        qstashClient,
        // The public URL, as with QStash: behind a proxy `request.url` is the internal one.
        url: this.config.url,
      },
    );
    return handler;
  }

  private required(): TaskEndpoints<WorkflowContext<WorkflowPayload>> {
    if (!this.endpoints) {
      throw new Error("WorkflowDispatcher is not attached — pass it to createTaskLayer().");
    }
    return this.endpoints;
  }
}

/**
 * Journals the core's own writes at the top level only: Workflow rejects a step inside a step, and
 * a handler may call `task.update` from inside its own `task.run`.
 */
function journalFor(context: WorkflowContext<WorkflowPayload>): TaskJournal {
  return async (name, fn) => (insideStep(context) ? await fn() : await context.run(name, fn));
}

/**
 * Reads Workflow's non-public `executor.executingStep`. If it disappears this falls back to a
 * plain write, and a test fails so we notice.
 */
export function insideStep(context: WorkflowContext<WorkflowPayload>): boolean {
  const executor = (context as unknown as { executor?: { executingStep?: string | false } })
    .executor;
  return executor === undefined || Boolean(executor.executingStep);
}
