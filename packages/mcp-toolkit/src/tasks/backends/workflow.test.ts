/**
 * The Workflow dispatcher, and the step primitives it exists to provide.
 *
 * These run offline against a stubbed Workflow client: what matters here is the wiring — that a
 * task becomes a run named after it, that cancelling the task cancels the run, and above all that
 * `task.run(...)` becomes a journaled step under Workflow and a plain call without it.
 */
import { Client as QStashClient } from "@upstash/qstash";
import { Client as WorkflowClient, WorkflowContext } from "@upstash/workflow";
import { describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { insideStep, WorkflowDispatcher, workflowRoute } from "./workflow.js";
import { createTaskLayer } from "../core.js";
import type { Task, TaskContext } from "../types.js";
import {
  ManualDispatcher,
  MemoryTaskStore,
  qstashRequest,
  testReceiver,
} from "../../test-support.js";

const URL = "https://example.com/api/workflow";

const task = (overrides: Partial<Task> = {}): Task => ({
  taskId: "task-1",
  status: "working",
  createdAt: "2026-10-08T10:00:00.000Z",
  lastUpdatedAt: "2026-10-08T10:00:00.000Z",
  ttlMs: 60_000,
  pollIntervalMs: 2_000,
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
      dispatcher: new WorkflowDispatcher({ url: URL }),
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

  it("triggers a run named after the task, so a double dispatch is deduplicated", async () => {
    const { client, triggered } = stubClient();
    const dispatcher = new WorkflowDispatcher({ url: URL, client });

    await dispatcher.dispatch(task());

    expect(triggered).toHaveLength(1);
    expect(triggered[0]?.url).toBe(URL);
    expect(triggered[0]?.body).toEqual({ taskId: "task-1" });
    expect(triggered[0]?.workflowRunId).toBe("task-1");
  });

  it("cancels the run itself, not just the task record", async () => {
    const { client, cancelled } = stubClient();
    const dispatcher = new WorkflowDispatcher({ url: URL, client });

    await dispatcher.cancel("task-1");

    // Unlike a queue, a workflow run can be stopped mid-flight rather than only un-queued.
    expect(cancelled).toEqual(["wfr_task-1"]);
  });

  it("cancels the run it triggered, with the real Workflow client", async () => {
    // The real client, only its HTTP stubbed: a stubbed client can't catch how the real one
    // names runs (`trigger` prefixes `wfr_`, `cancel` doesn't).
    const requests: { method: string; url: string; body: string; headers: string }[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: Parameters<typeof fetch>[1]) => {
        const url = String(input instanceof Request ? input.url : input);
        const method = init?.method ?? "GET";
        const headers = JSON.stringify(Object.fromEntries(new Headers(init?.headers).entries()));
        requests.push({ method, url, body: String(init?.body ?? ""), headers });
        return method === "DELETE"
          ? Response.json({ cancelled: 1 })
          : Response.json([{ messageId: "msg_1" }]);
      },
    );
    try {
      const client = new WorkflowClient({ token: "test-token", baseUrl: "https://qstash.test" });
      const dispatcher = new WorkflowDispatcher({ url: URL, client });
      const taskId = "6f1c2c5e-0000-4000-8000-000000000000";

      await dispatcher.dispatch(task({ taskId }));
      await dispatcher.cancel(taskId);

      const runId = `wfr_${taskId}`;
      const trigger = requests.find((r) => r.method !== "DELETE");
      const cancel = requests.find((r) => r.method === "DELETE");
      expect(`${trigger?.body}${trigger?.headers}`).toContain(runId);
      expect(new globalThis.URL(cancel!.url).searchParams.get("workflowRunIds")).toBe(runId);
    } finally {
      vi.unstubAllGlobals();
    }
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

  /** A layer with one `demo` task stored and ready to run. */
  async function layerWithTask<TContext>(
    handler: (task: TaskContext & TContext) => Promise<Record<string, unknown>>,
  ) {
    const store = new MemoryTaskStore();
    const dispatcher = new ManualDispatcher<TContext>();
    const tasks = createTaskLayer<TContext>({ store, dispatcher, principal: () => "local" });
    tasks.createExecuteHandler();
    await store.create(task({ taskId: "t1" }));
    tasks.define(
      "demo",
      { description: "d", inputSchema: { "~standard": {} } as never },
      async (_args, task) => await handler(task),
    );
    return { store, dispatcher };
  }

  /** Runs one task through the layer with whatever context the dispatcher would supply. */
  async function runWith<TContext>(
    context: TContext | undefined,
    handler: (task: TaskContext & TContext) => Promise<Record<string, unknown>>,
  ) {
    const { store, dispatcher } = await layerWithTask<TContext>(handler);
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
    const { dispatcher } = await layerWithTask<unknown>(async (task) => {
      await task.update("one");
      await task.update("two");
      return {};
    });

    await dispatcher.run("t1", undefined, async (name, fn) => {
      journaled.push(name);
      return await fn();
    });

    // Stable, call-ordered names — a replay re-runs the handler the same way, so each write lands
    // on the same journal entry and is not repeated.
    expect(journaled).toEqual(["mcp-task:update:1", "mcp-task:update:2"]);
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
  const endpoints = (ran: string[]) => ({
    run: async (taskId: string) => {
      ran.push(taskId);
    },
    fail: async () => undefined,
  });

  it("refuses to serve without signing keys, instead of running unverified", async () => {
    // The Workflow SDK's own default is to skip verification when the keys are missing.
    const saved = { ...process.env };
    delete process.env.QSTASH_CURRENT_SIGNING_KEY;
    delete process.env.QSTASH_NEXT_SIGNING_KEY;
    process.env.QSTASH_TOKEN = "test-token";
    try {
      const dispatcher = new WorkflowDispatcher({ url: URL });
      const handler = dispatcher.createExecuteHandler(endpoints([])); // building must not throw
      expect(() => handler(new Request(URL, { method: "POST", body: "{}" }))).toThrow(
        /signing keys/,
      );
    } finally {
      process.env = saved;
    }
  });

  it("refuses a signature QStash issued for another endpoint", async () => {
    // Workflow verifies with only body and signature. Without the URL bound in, a delivery signed
    // for any other route of the same QStash account would be accepted here.
    const receiver = testReceiver();
    const checkedUrls: (string | undefined)[] = [];
    const verify = receiver.verify.bind(receiver);
    receiver.verify = async (request) => {
      checkedUrls.push(request.url);
      return await verify(request);
    };
    const ran: string[] = [];
    const handler = new WorkflowDispatcher({
      url: URL,
      receiver,
      qstash: new QStashClient({ token: "test" }),
    }).createExecuteHandler(endpoints(ran));

    const response = await handler(
      qstashRequest(URL, { taskId: "t1" }, { sub: "https://example.com/api/other" }),
    );

    expect(response.ok).toBe(false);
    expect(ran).toEqual([]);
    expect(checkedUrls).toEqual([URL]);
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
      url: URL,
      initialPayload: {},
    });
    const executor = (context as unknown as { executor?: Record<string, unknown> }).executor;
    expect(executor).toBeDefined();
    expect(executor).toHaveProperty("executingStep", false);
    expect(insideStep(context as never)).toBe(false);
  });
});

describe("workflowRoute", () => {
  // Workflow authorizes every request, the failure callback included, by running the route
  // function on a context whose first step throws a sentinel. A route that throws anything else
  // first, or returns without a step, is refused, and failureFunction never runs.
  it("reaches a step before any task code runs", async () => {
    const steps: string[] = [];
    let ran = false;
    const authorizing = {
      requestPayload: { taskId: "task-1" },
      run: async (name: string) => {
        steps.push(name);
        throw new Error("first step reached");
      },
    };
    const route = workflowRoute({
      run: async () => {
        ran = true;
        throw new Error("the handler threw before its first step");
      },
      fail: async () => undefined,
    });
    await expect(route(authorizing as never)).rejects.toThrow("first step reached");
    expect(steps).toEqual(["mcp-task:start"]);
    expect(ran).toBe(false);
  });

  it("still reaches a step when there is no task to run", async () => {
    const steps: string[] = [];
    const route = workflowRoute({ run: async () => undefined, fail: async () => undefined });
    await route({
      requestPayload: {},
      run: async (name: string, fn: () => Promise<unknown>) => (steps.push(name), fn()),
    } as never);
    expect(steps).toEqual(["mcp-task:start"]);
  });
});
