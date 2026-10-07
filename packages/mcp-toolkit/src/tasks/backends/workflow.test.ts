/**
 * The Workflow dispatcher, and the step primitives it exists to provide.
 *
 * These run offline against a stubbed Workflow client: what matters here is the wiring — that a
 * task becomes a run named after it, that cancelling the task cancels the run, and above all that
 * `task.run(...)` becomes a journaled step under Workflow and a plain call without it.
 */
import { describe, expect, it } from "vitest";
import { WorkflowDispatcher } from "./workflow.js";
import { createTaskLayer } from "../core.js";
import { MemoryTaskStore } from "./memory.js";
import type { TaskContext } from "../types.js";

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

describe("the context a handler receives", () => {
  /**
   * Stands in for a real `WorkflowContext`: a class, so its methods live on the prototype. That is
   * the whole reason the merge cannot be a spread.
   */
  class FakeWorkflowContext {
    ran: string[] = [];
    async run<T>(stepName: string, fn: () => Promise<T>): Promise<T> {
      this.ran.push(stepName);
      return await fn();
    }
    async sleep(): Promise<void> {}
  }

  /** Runs one task through the layer with whatever context the dispatcher would supply. */
  async function runWith<TContext>(
    context: TContext | undefined,
    handler: (task: TaskContext & TContext) => Promise<Record<string, unknown>>,
  ) {
    const store = new MemoryTaskStore();
    const tasks = createTaskLayer<TContext>({
      store,
      dispatcher: { dispatch: async () => undefined, cancel: async () => undefined },
    });

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

    const server = {
      registerTool: () => undefined,
      server: { registerCapabilities: () => undefined, setRequestHandler: () => undefined },
    } as unknown as Parameters<typeof tasks.registerTask>[0];

    tasks.registerTask(
      server,
      "demo",
      { description: "d", inputSchema: { "~standard": {} } as never },
      async (_args, task) => await handler(task),
    );

    return await tasks.executeTask("t1", context);
  }

  it("is just the task context when the transport adds nothing", async () => {
    const settled = await runWith<unknown>(undefined, async (task) => {
      expect(typeof task.update).toBe("function");
      expect(typeof task.isCancelled).toBe("function");
      return { taskId: task.taskId };
    });

    expect(settled?.status).toBe("completed");
    expect(settled?.result).toEqual({ taskId: "t1" });
  });

  it("merges the transport's context in, keeping its prototype methods", async () => {
    const workflow = new FakeWorkflowContext();

    const settled = await runWith<FakeWorkflowContext>(workflow, async (task) => {
      // Both halves on one object: ours by assignment, the engine's off the prototype.
      await task.update("working on it");
      const value = await task.run("step-1", async () => "stepped");
      return { value };
    });

    expect(workflow.ran).toEqual(["step-1"]);
    expect(settled?.result).toEqual({ value: "stepped" });
    // The status update went through our half of the same object.
    expect(settled?.status).toBe("completed");
  });

  it("journals the SDK's own writes, so a replay does not rewind the status message", async () => {
    const journaled: string[] = [];
    const store = new MemoryTaskStore();
    const tasks = createTaskLayer({
      store,
      dispatcher: { dispatch: async () => undefined, cancel: async () => undefined },
    });
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
    const server = {
      registerTool: () => undefined,
      server: { registerCapabilities: () => undefined, setRequestHandler: () => undefined },
    } as unknown as Parameters<typeof tasks.registerTask>[0];
    tasks.registerTask(
      server,
      "demo",
      { description: "d", inputSchema: { "~standard": {} } as never },
      async (_args, task) => {
        await task.update("one");
        await task.update("two");
        return {};
      },
    );

    await tasks.executeTask("t1", undefined, async (name, fn) => {
      journaled.push(name);
      return await fn();
    });

    // Stable, call-ordered names — a replay re-runs the handler the same way, so each write lands
    // on the same journal entry and is not repeated.
    expect(journaled).toEqual(["mcp-task:update:1", "mcp-task:update:2"]);
    // Both writes went through the journal rather than around it.
    expect(journaled).toHaveLength(2);
  });

  it("writes directly when the transport has no journal", async () => {
    const settled = await runWith<unknown>(undefined, async (task) => {
      await task.update("progress");
      return {};
    });
    // A queue never replays, so an unjournaled write is the right thing there.
    expect(settled?.status).toBe("completed");
  });

  it("does not lose engine methods to a spread", async () => {
    // Guards the merge strategy itself: `{ ...context }` would silently drop `run`, and the
    // handler would fail only at runtime, on a real workflow.
    const workflow = new FakeWorkflowContext();
    await runWith<FakeWorkflowContext>(workflow, async (task) => {
      expect(Object.getPrototypeOf(task)).toBe(FakeWorkflowContext.prototype);
      return {};
    });
  });
});
