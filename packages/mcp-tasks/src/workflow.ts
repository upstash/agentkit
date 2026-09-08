/**
 * The Upstash Workflow dispatcher — the one that can run a task longer than a function invocation.
 *
 * {@link QStashDispatcher} delivers a task as a single HTTP request, so the whole handler has to
 * finish inside one serverless invocation. Exceed the platform's limit and the invocation is
 * killed; the redelivery then restarts the handler from the beginning, because nothing recorded
 * how far it got. For work measured in minutes or hours that is a livelock, not durability.
 *
 * Workflow splits the same handler across invocations: every `task.run(...)` step is its own
 * request, and a completed step is replayed from the journal instead of being executed again. The
 * task's own record still lives in the {@link TaskStore} exactly as before — this changes what
 * drives the work, not where its state is kept.
 */
import { Client as WorkflowClient } from "@upstash/workflow";
import { serve, type WorkflowContext } from "@upstash/workflow";
import type { TaskDispatcher, TaskEndpoints, TaskSteps } from "./types.js";

/** JSON-RPC internal error, per the MCP spec — inlined so this file imports no MCP SDK. */
const INTERNAL_ERROR = -32603;

export type WorkflowDispatcherConfig = {
  /** The Workflow client. Defaults to `new Client({ token: QSTASH_TOKEN, baseUrl: QSTASH_URL })`. */
  client?: WorkflowClient;
  /**
   * The absolute, publicly reachable URL of the workflow endpoint — the route that serves
   * `tasks.createExecuteHandler()`. It must be reachable *from QStash*, not just from your app.
   */
  url: string;
  /** Extra headers to send when triggering a run. */
  headers?: Record<string, string>;
  /**
   * How many times a failing request in the run is retried before the run fails. Defaults to the
   * Workflow SDK's own default.
   *
   * Worth noting how much more this buys than the queue equivalent: retries apply per step, so a
   * task made of five steps gets five independent retry budgets, and a retry resumes from the
   * journal rather than restarting the handler.
   */
  retries?: number;
};

/** The body we trigger a run with, and read back inside the workflow. */
type WorkflowPayload = { taskId?: string };

/**
 * Runs each task as an Upstash Workflow run, one invocation per step.
 *
 * Cancellation composes: `tasks/cancel` settles the record and calls {@link cancel}, which stops
 * the run itself rather than waiting for the handler to notice at its next `isCancelled()` check.
 */
export class WorkflowDispatcher implements TaskDispatcher {
  private readonly url: string;
  private readonly headers: Record<string, string> | undefined;
  private readonly retries: number | undefined;
  private readonly resolveClient: () => WorkflowClient;
  private workflow: WorkflowClient | undefined;
  private endpoints: TaskEndpoints | undefined;

  constructor(config: WorkflowDispatcherConfig) {
    this.url = config.url;
    this.headers = config.headers;
    this.retries = config.retries;
    this.resolveClient = () => config.client ?? clientFromEnv();
  }

  attach(endpoints: TaskEndpoints): void {
    this.endpoints = endpoints;
  }

  /** Resolved on first use, so constructing at module scope needs no credentials. */
  private get client(): WorkflowClient {
    if (!this.workflow) this.workflow = this.resolveClient();
    return this.workflow;
  }

  async dispatch(taskId: string): Promise<string | undefined> {
    const { workflowRunId } = await this.client.trigger({
      url: this.url,
      body: { taskId } satisfies WorkflowPayload,
      headers: this.headers,
      retries: this.retries,
      // Naming the run after the task makes the trigger idempotent — a double-submitted tool call
      // is deduplicated by Workflow rather than starting the task twice.
      workflowRunId: taskId,
    });
    return workflowRunId;
  }

  async cancel(dispatchId: string): Promise<void> {
    await this.client.cancel(dispatchId);
  }

  /**
   * The workflow endpoint, as a fetch handler: `export const POST = tasks.createExecuteHandler()`.
   *
   * Signature verification, replay and step journaling are all Workflow's, so unlike the QStash
   * handler there is nothing here to get wrong by hand. The `failureFunction` is the counterpart
   * of QStash's failure callback: it fires once the run has exhausted its retries, and is the only
   * thing that settles the task `failed`.
   */
  createExecuteHandler(): (request: Request) => Promise<Response> {
    const { handler } = serve<WorkflowPayload>(
      async (context) => {
        const endpoints = this.required();
        const taskId = context.requestPayload?.taskId;
        if (!taskId) return;
        await endpoints.run(taskId, stepsFor(context));
      },
      {
        failureFunction: async ({ context, failStatus, failResponse }) => {
          const endpoints = this.required();
          const taskId = (context.requestPayload as WorkflowPayload | undefined)?.taskId;
          if (!taskId) return;
          await endpoints.fail(taskId, {
            code: INTERNAL_ERROR,
            message: `Workflow run failed${failStatus ? ` (status ${failStatus})` : ""}`,
            data: { response: failResponse, workflowRunId: context.workflowRunId },
          });
        },
      },
    );

    return handler;
  }

  private required(): TaskEndpoints {
    if (!this.endpoints) {
      throw new Error(
        "This dispatcher is not attached to a task layer — pass it to createTaskLayer().",
      );
    }
    return this.endpoints;
  }
}

/**
 * Bridges the workflow context onto the task context's step primitives.
 *
 * This is the whole upgrade: `task.run(...)` stops being a plain function call and becomes a
 * journaled step that survives the invocation it started in.
 */
function stepsFor(context: WorkflowContext<WorkflowPayload>): TaskSteps {
  return {
    run: (stepName, fn) => context.run(stepName, fn),
    // Workflow sleeps cost no compute and can outlast any invocation, unlike a timer.
    sleep: (stepName, seconds) => context.sleep(stepName, seconds),
  };
}

function clientFromEnv(): WorkflowClient {
  const token = process.env.QSTASH_TOKEN;
  if (!token) {
    throw new Error("WorkflowDispatcher needs a client: pass `client`, or set QSTASH_TOKEN.");
  }
  return new WorkflowClient({ token, baseUrl: process.env.QSTASH_URL });
}
