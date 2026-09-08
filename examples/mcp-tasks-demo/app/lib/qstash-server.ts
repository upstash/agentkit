/**
 * Server one: the task runs on **QStash**.
 *
 * One delivery, one invocation. The work survives the process dying — QStash redelivers — but the
 * whole handler still has to finish inside your platform's function limit, and a redelivery
 * restarts it from the beginning. Good for work measured in seconds.
 *
 * Compare with `workflow-server.ts`, which runs the same-looking tool with no time limit at all.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { createTaskLayer, TASKS_PROTOCOL_VERSION } from "@upstash/mcp-tasks";
import { QStashDispatcher, RedisTaskStore } from "@upstash/mcp-tasks/upstash";
import * as z from "zod";

/** Where QStash delivers. Must be reachable *from QStash*, not just from your browser. */
export const EXECUTE_URL = `${process.env.APP_URL ?? "http://127.0.0.1:3000"}/api/execute`;

// `retries` and `retryDelay` are left at their defaults — five attempts over ~2 minutes, so a task
// outlives a restart instead of dead-lettering while its record still reads `working`.
export const dispatcher = new QStashDispatcher({ url: EXECUTE_URL });

/**
 * No type argument: a queue adds nothing to the handler's context, so the handler receives just
 * the `TaskContext` — `taskId`, `update`, `isCancelled`.
 */
export const tasks = createTaskLayer({
  store: new RedisTaskStore({ prefix: "mcp:task:qstash:" }),
  dispatcher,
  defaults: { ttlMs: 300_000, pollIntervalMs: 2_000 },
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const STEPS = 4;

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "mcp-tasks-demo-qstash", version: "0.1.0" },
    // Without this the transport validates the request's `mcp-protocol-version` header against
    // the SDK's 2025-era list and rejects every 2026-07-28 request before it reaches a handler.
    { supportedProtocolVersions: [TASKS_PROTOCOL_VERSION] },
  );

  tasks.registerTask(
    server,
    "generate_report",
    {
      title: "Generate report",
      description: `Generates a report on a topic in ${STEPS} steps, on QStash. Returns a task handle immediately.`,
      inputSchema: z.object({ topic: z.string().describe("What the report should be about") }),
      completedMessage: "Report ready",
    },
    // Two arguments: the tool's input, and the task. There is no third — see workflow-server.ts.
    async ({ topic }, task) => {
      for (let step = 1; step <= STEPS; step++) {
        // Cancellation is cooperative: running code only stops where it checks.
        if (await task.isCancelled()) {
          console.log(`[qstash] task=${task.taskId} cancelled before step ${step}`);
          return {};
        }
        await task.update(`Step ${step}/${STEPS}: processing ${topic}`);
        // Plain sleep, inside the one invocation. Push this past the function limit and the work
        // is killed and restarted from step 1 — which is exactly what the workflow server fixes.
        await sleep(2_500);
      }

      return {
        content: [{ type: "text", text: `Report complete: ${topic}` }],
        structuredContent: { report: `A concise report about ${topic}.` },
      };
    },
  );

  return server;
}

// The delivery endpoint receives only a task id and looks the handler up by the tool name stored
// on the task, so the registry has to be populated even when `/api/execute` is the first route hit
// in this process. This server is never connected to a transport.
createServer();
