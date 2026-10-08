/**
 * The Upstash Workflow dispatcher, for work longer than one function invocation: every
 * `task.run(...)` step is its own request, and a finished step is replayed from the journal.
 */
import type { Client as QStashClient, Receiver } from "@upstash/qstash";
import { Client as WorkflowClient, serve, type WorkflowContext } from "@upstash/workflow";
import {
  INTERNAL_ERROR,
  boundToUrl,
  env,
  lazy,
  requireEnv,
  resolveQStash,
  resolveReceiver,
} from "../../shared/clients.js";
import { addQStashTelemetry } from "../../telemetry.js";
import type { Task, TaskDispatcher, TaskEndpoints, TaskJournal } from "../types.js";

export type WorkflowDispatcherConfig = {
  /** The public URL of the route serving `tasks.createExecuteHandler()`, reachable from QStash. */
  url: string;
  /** The Workflow client. Defaults to one from `QSTASH_TOKEN` (and `QSTASH_URL`). */
  client?: WorkflowClient;
  /** The QStash client the endpoint schedules steps with. Defaults to one from `QSTASH_TOKEN`. */
  qstash?: QStashClient;
  /**
   * Verifies every request to the endpoint. Defaults to one from the `QSTASH_*_SIGNING_KEY` env
   * vars. Required either way: Workflow itself skips verification when they are missing.
   */
  receiver?: Receiver;
  /** Retries per step. Defaults to the Workflow SDK's default. */
  retries?: number;
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
  }

  async dispatch(task: Task): Promise<void> {
    await this.client().trigger({
      url: this.config.url,
      body: { taskId: task.taskId } satisfies WorkflowPayload,
      retries: this.config.retries,
      // One run per task: Workflow refuses a run id that was already used. It prefixes this with
      // `wfr_` itself, so the run is `runIdOf(taskId)`.
      workflowRunId: task.taskId,
    });
  }

  async cancel(taskId: string): Promise<void> {
    await this.client().cancel(runIdOf(taskId));
  }

  /** The workflow endpoint. Its `failureFunction` settles the task `failed` once retries run out. */
  createExecuteHandler(
    endpoints: TaskEndpoints<WorkflowContext<WorkflowPayload>>,
  ): (request: Request) => Promise<Response> {
    // Built on the first request: route modules are evaluated at build time, without the keys.
    const handler = lazy(() => this.buildHandler(endpoints));
    return (request) => handler()(request);
  }

  private buildHandler(
    endpoints: TaskEndpoints<WorkflowContext<WorkflowPayload>>,
  ): (request: Request) => Promise<Response> {
    const { url } = this.config;
    // Resolved here, so a missing key throws instead of serving unverified.
    const receiver = resolveReceiver("WorkflowDispatcher", this.config.receiver);
    const qstashClient = resolveQStash(
      "WorkflowDispatcher",
      this.config.qstash,
      this.config.enableTelemetry,
    );
    const { handler } = serve<WorkflowPayload>(workflowRoute(endpoints), {
      failureFunction: async ({ context, failStatus, failResponse }) => {
        const taskId = (context.requestPayload as WorkflowPayload | undefined)?.taskId;
        if (!taskId) return;
        // `failResponse` is the thrown error's message: database errors, internal hosts, upstream
        // responses. It goes to your logs, never into the task, which its owner can read.
        console.error(
          `[mcp-toolkit] task ${taskId} failed (workflow run ${context.workflowRunId}):`,
          failResponse,
        );
        await endpoints.fail(taskId, {
          code: INTERNAL_ERROR,
          message: `Workflow run failed${failStatus ? ` (status ${failStatus})` : ""}`,
          data: { workflowRunId: context.workflowRunId },
        });
      },
      // Workflow verifies only body and signature; binding the URL refuses a signature that
      // QStash issued for any other endpoint of the same account.
      receiver: boundToUrl(receiver, url),
      qstashClient,
      // The public URL, as with QStash: behind a proxy `request.url` is the internal one.
      url,
    });
    return handler;
  }
}

/**
 * The Workflow run that serves a task. `Client.trigger` turns the `workflowRunId` it is given into
 * `wfr_<id>`, while `Client.cancel` takes the run id as is, so a cancel must add the prefix.
 */
export const runIdOf = (taskId: string): string => `wfr_${taskId}`;

/**
 * The workflow's route function. Its first act is always a step: Workflow authorizes every request,
 * the failure callback included, by running the route function until its first step, and refuses
 * one that throws or returns before reaching any. Without this, a handler that throws before its
 * first `task.run` (or a run whose task was already cancelled) never gets `failureFunction`, and
 * the task reads `working` until its TTL.
 */
export function workflowRoute(
  endpoints: TaskEndpoints<WorkflowContext<WorkflowPayload>>,
): (context: WorkflowContext<WorkflowPayload>) => Promise<void> {
  return async (context) => {
    const taskId = await context.run(
      "mcp-task:start",
      async () => context.requestPayload?.taskId ?? null,
    );
    if (taskId) await endpoints.run(taskId, context, journalFor(context));
  };
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
