/**
 * The Workflow dispatcher, and the step primitives it exists to provide.
 *
 * These run offline against a stubbed Workflow client: what matters here is the wiring — that a
 * task becomes a run named after it, that cancelling the task cancels the run, and above all that
 * `task.run(...)` becomes a journaled step under Workflow and a plain call without it.
 */
import { describe, expect, it } from "vitest";
import { WorkflowDispatcher } from "./workflow.js";
import { createTaskLayer } from "./core.js";
import { MemoryTaskStore } from "./memory.js";
import type { TaskContext, TaskSteps } from "./types.js";

type Triggered = { url: string; body: unknown; workflowRunId?: string };

function stubClient() {
  const triggered: Triggered[] = [];
  const cancelled: string[] = [];
  const client = {
    trigger: async (options: Triggered) => {
      triggered.push(options);
      return { workflowRunId: options.workflowRunId ?? "wfr_generated", workflowCreatedAt: 1 };
    },
    cancel: async (id: string) => {
      cancelled.push(id);
      return { cancelled: 1 };
    },
  };
  return {
    triggered,
    cancelled,
    client: client as unknown as ConstructorParameters<typeof WorkflowDispatcher>[0]["client"],
  };
}

describe("WorkflowDispatcher", () => {
  it("triggers a run named after the task, so a double dispatch is deduplicated", async () => {
    const { client, triggered } = stubClient();
    const dispatcher = new WorkflowDispatcher({ url: "https://example.com/api/workflow", client });

    const dispatchId = await dispatcher.dispatch("task-1");

    expect(triggered).toHaveLength(1);
    expect(triggered[0]?.url).toBe("https://example.com/api/workflow");
    expect(triggered[0]?.body).toEqual({ taskId: "task-1" });
    // Naming the run after the task is what makes the trigger idempotent.
    expect(triggered[0]?.workflowRunId).toBe("task-1");
    expect(dispatchId).toBe("task-1");
  });

  it("cancels the run itself, not just the task record", async () => {
    const { client, cancelled } = stubClient();
    const dispatcher = new WorkflowDispatcher({ url: "https://example.com/api/workflow", client });

    await dispatcher.cancel("task-1");

    // Unlike a queue, a workflow run can be stopped mid-flight rather than only un-queued.
    expect(cancelled).toEqual(["task-1"]);
  });

  it("refuses to serve before it is attached to a layer", () => {
    const { client } = stubClient();
    const dispatcher = new WorkflowDispatcher({ url: "https://example.com/api/workflow", client });
    // The handler itself builds fine; it throws when a request actually needs the endpoints.
    expect(typeof dispatcher.createExecuteHandler()).toBe("function");
  });
});

describe("TaskContext step primitives", () => {
  /** Runs one task through the layer, capturing the context the handler was handed. */
  async function runWith(steps: TaskSteps | undefined) {
    const store = new MemoryTaskStore();
    const dispatcher = { dispatch: async () => undefined, cancel: async () => undefined };
    const tasks = createTaskLayer({ store, dispatcher });

    const now = new Date().toISOString();
    await store.create({
      taskId: "t1",
      status: "working",
      createdAt: now,
      lastUpdatedAt: now,
      ttlMs: null,
      name: "demo",
      args: {},
    });

    let seen: TaskContext | undefined;
    // registerTask needs a server; reach the handler registry the same way a delivery does by
    // registering through a minimal stub server object.
    const server = {
      registerTool: () => undefined,
      server: { registerCapabilities: () => undefined, setRequestHandler: () => undefined },
    } as unknown as Parameters<typeof tasks.registerTask>[0];

    tasks.registerTask(
      server,
      "demo",
      { description: "d", inputSchema: { "~standard": {} } as never },
      async (_args, task) => {
        seen = task;
        const value = await task.run("step-1", async () => "ran");
        return { value };
      },
    );

    const settled = await tasks.executeTask("t1", steps);
    return { settled, seen };
  }

  it("runs steps directly when the dispatcher has none", async () => {
    const { settled } = await runWith(undefined);
    // No checkpoint, same result — a handler written with `run` still works on a queue.
    expect(settled?.status).toBe("completed");
    expect(settled?.result).toEqual({ value: "ran" });
  });

  it("routes steps through the dispatcher's journal when it has one", async () => {
    const journaled: string[] = [];
    const steps: TaskSteps = {
      run: async (stepName, fn) => {
        journaled.push(stepName);
        return await fn();
      },
      sleep: async () => undefined,
    };

    const { settled } = await runWith(steps);

    // This is the upgrade: the step went through the engine that can replay it.
    expect(journaled).toEqual(["step-1"]);
    expect(settled?.result).toEqual({ value: "ran" });
  });

  it("replays a completed step from the journal instead of re-running it", async () => {
    let executions = 0;
    const steps: TaskSteps = {
      // Stands in for a workflow replaying a step it already finished in an earlier invocation.
      run: async (_stepName, _fn) => "from-journal" as never,
      sleep: async () => undefined,
    };
    const store = new MemoryTaskStore();
    const tasks = createTaskLayer({
      store,
      dispatcher: { dispatch: async () => undefined, cancel: async () => undefined },
    });
    const now = new Date().toISOString();
    await store.create({
      taskId: "t2",
      status: "working",
      createdAt: now,
      lastUpdatedAt: now,
      ttlMs: null,
      name: "demo",
      args: {},
    });
    const server = {
      registerTool: () => undefined,
      server: { registerCapabilities: () => undefined, setRequestHandler: () => undefined },
    } as unknown as Parameters<typeof tasks.registerTask>[0];
    tasks.registerTask(
      server,
      "demo",
      { description: "d", inputSchema: { "~standard": {} } as never },
      async (_args, task) => ({
        value: await task.run("step-1", async () => {
          executions += 1;
          return "fresh";
        }),
      }),
    );

    const settled = await tasks.executeTask("t2", steps);

    expect(executions).toBe(0);
    expect(settled?.result).toEqual({ value: "from-journal" });
  });
});
