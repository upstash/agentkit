/**
 * The whole server-side wiring: a store, a dispatcher, and one task tool.
 *
 * Both routes import from here — `/api/mcp` to serve the protocol, `/api/execute` to run the work
 * the dispatcher delivers back.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { createTaskLayer, TASKS_PROTOCOL_VERSION, type TaskDispatcher } from "@upstash/mcp-tasks";
import { QStashDispatcher, RedisTaskStore } from "@upstash/mcp-tasks/upstash";
import { WorkflowDispatcher } from "@upstash/mcp-tasks/workflow";
import * as z from "zod";

/** Where the work is delivered. It has to be reachable *from QStash*, not just from your browser. */
export const EXECUTE_URL = `${process.env.APP_URL ?? "http://127.0.0.1:3000"}/api/execute`;

/**
 * Which transport runs the work. Both serve the *same* route, which is the point of the split:
 *
 * - `qstash` (default) — one delivery, one invocation. Survives a crash, but the whole handler has
 *   to fit inside your platform's function limit.
 * - `workflow` — one invocation per step, replayed from a journal. Survives a crash *and* outlives
 *   the function limit, so a task can take hours.
 *
 * The task handler below is identical either way.
 */
const driver = process.env.TASKS_DRIVER === "workflow" ? "workflow" : "qstash";

export const dispatcher: TaskDispatcher =
  driver === "workflow"
    ? new WorkflowDispatcher({ url: EXECUTE_URL })
    : // `retries` and `retryDelay` are left at their defaults — five attempts spread over ~2
      // minutes, so a task outlives a restart instead of dead-lettering while it reads `working`.
      new QStashDispatcher({ url: EXECUTE_URL });

export const tasks = createTaskLayer({
  // Both default to `fromEnv()`, so there is no client to thread through.
  store: new RedisTaskStore(),
  dispatcher,
  defaults: { ttlMs: 300_000, pollIntervalMs: 2_000 },
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const STEPS = 4;

/**
 * Builds a server with the demo's task tool on it.
 *
 * A fresh one per request: the transport below is stateless, and an `McpServer` owns the single
 * transport it is connected to.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: "upstash-mcp-tasks-demo", version: "0.1.0" },
    // Without this the transport validates the request's `mcp-protocol-version` header against
    // the SDK's 2025-era list and rejects every 2026-07-28 request before it reaches a handler.
    { supportedProtocolVersions: [TASKS_PROTOCOL_VERSION] },
  );

  tasks.registerTask(
    server,
    "generate_report",
    {
      title: "Generate report",
      description: `Generates a report on a topic in ${STEPS} durable steps. Returns a task handle immediately.`,
      inputSchema: z.object({ topic: z.string().describe("What the report should be about") }),
      completedMessage: "Report ready",
    },
    async ({ topic }, task) => {
      for (let step = 1; step <= STEPS; step++) {
        // Cancellation is cooperative: running code only stops where it checks, so the check
        // goes at every step boundary. This is a read, so re-running it on a replay is fine —
        // it just sees the current status.
        if (await task.isCancelled()) {
          console.log(`[execute] task=${task.taskId} cancelled before step ${step}`);
          return {};
        }

        // Everything with a side effect goes *inside* `task.run`. Under the workflow driver the
        // handler is re-entered once per step, replaying finished steps from the journal — so
        // code outside a step runs again on every invocation, and a status update left out here
        // would rewind the progress message on each replay.
        await task.run(`step-${step}`, async () => {
          await task.update(`Step ${step}/${STEPS}: processing ${topic}`);
          await sleep(2_500);
        });
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
// on the task — so the handler registry has to be populated even when `/api/execute` is the first
// route hit in this process. Registering once at module load does that; the server built here is
// never connected to a transport.
createServer();
