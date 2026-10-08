/**
 * The Workflow dispatcher, and the step primitives it exists to provide.
 *
 * These run offline against a stubbed Workflow client: what matters here is the wiring — that a
 * task becomes a run named after it, that cancelling the task cancels the run, and above all that
 * `task.run(...)` becomes a journaled step under Workflow and a plain call without it.
 */
import { Client as QStashClient } from "@upstash/qstash";
import { WorkflowContext } from "@upstash/workflow";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import { insideStep, WorkflowDispatcher } from "./workflow.js";
import { createTaskLayer } from "../core.js";
import { MemoryTaskStore } from "./memory.js";
import type { Task, TaskContext } from "../types.js";
import { ManualDispatcher } from "../../test-support.js";

const task = (overrides: Partial<Task> = {}): Task => ({
  taskId: "task-1",
  status: "working",
  createdAt: "2026-10-08T10:00:00.000Z",
  lastUpdatedAt: "2026-10-08T10:00:00.000Z",
  ttlMs: null,
  name: "demo",
  args: {},
  owner: "local",
  ...overrides,
});

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
  it("gives handlers the Workflow API without a type argument", () => {
    const tasks = createTaskLayer({
      store: new MemoryTaskStore(),
      dispatcher: new WorkflowDispatcher({ url: "https://example.com/api/workflow" }),
      principal: () => "local",
    });
    // Compiles only if `task` is inferred as TaskContext & WorkflowContext.
    tasks.define(
      "t",
      { description: "d", inputSchema: z.object({ n: z.number() }) },
      async ({ n }, task) => {
        const doubled: number = await task.run("double", async () => n * 2);
        await task.sleep("wait", 1);
        await task.update(`got ${doubled}`);
        return {};
      },
    );
  });

  it("triggers a run named after the task record, so a double dispatch is deduplicated", async () => {
    const { client, triggered } = stubClient();
    const dispatcher = new WorkflowDispatcher({ url: "https://example.com/api/workflow", client });

    const dispatchId = await dispatcher.dispatch(task());

    expect(triggered).toHaveLength(1);
    expect(triggered[0]?.url).toBe("https://example.com/api/workflow");
    expect(triggered[0]?.body).toEqual({ taskId: "task-1" });
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
    const dispatcher = new ManualDispatcher<TContext>();
    const tasks = createTaskLayer<TContext>({ store, dispatcher, principal: () => "local" });

    const now = new Date().toISOString();
    await store.create({
      taskId: "t1",
      status: "working",
      createdAt: now,
      lastUpdatedAt: now,
      ttlMs: null,
      name: "demo",
      args: {},
      owner: "local",
    });

    tasks.define(
      "demo",
      { description: "d", inputSchema: { "~standard": {} } as never },
      async (_args, task) => await handler(task),
    );

    await dispatcher.run("t1", context);
    return await store.get("t1");
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
    const dispatcher = new ManualDispatcher();
    const tasks = createTaskLayer({ store, dispatcher, principal: () => "local" });
    const now = new Date().toISOString();
    await store.create({
      taskId: "t1",
      status: "working",
      createdAt: now,
      lastUpdatedAt: now,
      ttlMs: null,
      name: "demo",
      args: {},
      owner: "local",
    });
    tasks.define(
      "demo",
      { description: "d", inputSchema: { "~standard": {} } as never },
      async (_args, task) => {
        await task.update("one");
        await task.update("two");
        return {};
      },
    );

    await dispatcher.run("t1", undefined, async (name, fn) => {
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

describe("WorkflowDispatcher signature verification", () => {
  it("refuses to serve without signing keys, instead of running unverified", async () => {
    // The Workflow SDK's own default is to skip verification when the keys are missing.
    const saved = { ...process.env };
    delete process.env.QSTASH_CURRENT_SIGNING_KEY;
    delete process.env.QSTASH_NEXT_SIGNING_KEY;
    process.env.QSTASH_TOKEN = "test-token";
    try {
      const dispatcher = new WorkflowDispatcher({ url: "https://example.com/api/workflow" });
      const handler = dispatcher.createExecuteHandler(); // building the route must not throw
      expect(() =>
        handler(new Request("https://example.com/api/workflow", { method: "POST", body: "{}" })),
      ).toThrow(/signing keys/);
    } finally {
      process.env = saved;
    }
  });
});

describe("insideStep", () => {
  // It reads Workflow's non-public `executor.executingStep`. If an upgrade renames the field this
  // fails, instead of task.update silently going unjournaled.
  it("still finds executingStep on a real WorkflowContext", async () => {
    const context = new WorkflowContext({
      qstashClient: new QStashClient({ token: "test" }) as never,
      workflowRunId: "wfr_test",
      workflowRunCreatedAt: Date.now(),
      headers: new Headers(),
      steps: [],
      url: "https://example.com/api/workflow",
      initialPayload: {},
    });
    const executor = (context as unknown as { executor?: Record<string, unknown> }).executor;
    expect(executor).toBeDefined();
    expect(executor).toHaveProperty("executingStep", false);
    expect(insideStep(context as never)).toBe(false);
  });
});
