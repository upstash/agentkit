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
import { createTaskLayer } from "@upstash/mcp-toolkit/tasks";
import { QStashDispatcher, RedisTaskStore } from "@upstash/mcp-toolkit/tasks/upstash";
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

const STEP_NAMES = ["gathering sources", "reading", "outlining", "writing"];
const STEPS = STEP_NAMES.length;

export function createServer(): McpServer {
  const server = new McpServer({ name: "report-desk", version: "0.1.0" });

  tasks.registerTask(
    server,
    "generate_report",
    {
      title: "Generate report",
      description: `Generates a report on a topic in ${STEPS} steps, on QStash.`,
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
        await task.update(`Step ${step}/${STEPS}: ${STEP_NAMES[step - 1]}`);
        // Plain sleep, inside the one invocation. Push this past the function limit and the work
        // is killed and restarted from step 1 — which is exactly what the workflow server fixes.
        await sleep(2_500);
      }

      // A canned report: the demo is about the task lifecycle, not the writing.
      const report = [
        `# ${topic}`,
        `Sources reviewed: 12 (4 primary, 8 secondary).`,
        `Key finding: interest in ${topic} grew steadily over the last three years.`,
        `Open question: which of the competing explanations holds up under more data.`,
        `Recommendation: run a small follow-up study before committing budget.`,
      ].join("\n");
      return {
        content: [{ type: "text", text: report }],
        structuredContent: { topic, sources: 12, report },
      };
    },
  );

  return server;
}

// The delivery endpoint receives only a task id and looks the handler up by the tool name stored
// on the task, so the registry has to be populated even when `/api/execute` is the first route hit
// in this process. This server is never connected to a transport.
createServer();
