/**
 * Server two: the task runs on **Upstash Workflow**.
 *
 * One invocation per step, with finished steps replayed from a journal instead of re-executed, so
 * the task as a whole has no time limit. The tool looks the same to the client; only its
 * durability differs.
 *
 * The visible difference in code is the handler's context. `createTaskLayer<WorkflowContext>`
 * makes it `TaskContext & WorkflowContext`, so `task.update(...)` (ours) and `task.run(...)`,
 * `task.sleep(...)`, `task.call(...)` (the engine's) sit on one object.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { createTaskLayer, TASKS_PROTOCOL_VERSION } from "@upstash/mcp-tasks";
import { RedisTaskStore, WorkflowDispatcher } from "@upstash/mcp-tasks/upstash";
import type { WorkflowContext } from "@upstash/workflow";
import * as z from "zod";

/** Where Workflow delivers each step. Must be reachable *from QStash*. */
export const EXECUTE_URL = `${process.env.APP_URL ?? "http://127.0.0.1:3000"}/api/execute-workflow`;

export const dispatcher = new WorkflowDispatcher({ url: EXECUTE_URL });

/**
 * The type argument is the whole point: it flows into `registerTask`, so the handler below is
 * typed with the engine's API and the compiler rejects a workflow handler wired to a queue.
 */
export const tasks = createTaskLayer<WorkflowContext>({
  store: new RedisTaskStore({ prefix: "mcp:task:workflow:" }),
  dispatcher,
  // A workflow task can take far longer than a queued one, so give the record room to outlive it.
  defaults: { ttlMs: 3_600_000, pollIntervalMs: 2_000 },
});

const STEPS = 4;

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "mcp-tasks-demo-workflow", version: "0.1.0" },
    { supportedProtocolVersions: [TASKS_PROTOCOL_VERSION] },
  );

  tasks.registerTask(
    server,
    "generate_report",
    {
      title: "Generate report",
      description: `Generates a report on a topic in ${STEPS} durable steps, on Upstash Workflow. Returns a task handle immediately.`,
      inputSchema: z.object({ topic: z.string().describe("What the report should be about") }),
      completedMessage: "Report ready",
    },
    async ({ topic }, task) => {
      for (let step = 1; step <= STEPS; step++) {
        // A read, so re-running it on every replay is fine — it just sees the current status.
        if (await task.isCancelled()) {
          console.log(`[workflow] task=${task.taskId} cancelled before step ${step}`);
          return {};
        }

        // `task.update` needs no wrapping: the SDK journals its own writes, so this runs once
        // even though the handler is re-entered on every step.
        await task.update(`Step ${step}/${STEPS}: processing ${topic}`);

        // Your work does need a step. This is what makes the task outlive one invocation —
        // each `task.run` is its own request, and finished ones replay from the journal.
        await task.run(`step-${step}`, () => new Promise((resolve) => setTimeout(resolve, 2_500)));
      }

      return {
        content: [{ type: "text", text: `Report complete: ${topic}` }],
        structuredContent: { report: `A concise report about ${topic}.` },
      };
    },
  );

  return server;
}

createServer();
