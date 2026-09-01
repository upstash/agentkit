/**
 * The runtime, exercised through a real `McpServer` and a real transport — the requests below are
 * genuine JSON-RPC over the wire, not direct calls into the layer.
 */
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import * as z from "zod";
import { createTaskLayer, TASKS_EXTENSION, TASKS_PROTOCOL_VERSION } from "./core.js";
import { InlineTaskDispatcher, MemoryTaskStore } from "./memory.js";
import type { TaskContext, TaskLayer, WireTask } from "./index.js";
import { sleep } from "./test-support.js";

type Rpc = (
  method: string,
  params?: Record<string, unknown>,
  options?: { withTasksCapability?: boolean },
) => Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }>;

type Harness = {
  rpc: Rpc;
  tasks: TaskLayer;
  store: MemoryTaskStore;
  dispatcher: InlineTaskDispatcher;
  close: () => Promise<void>;
};

/** Builds a server with one task tool backed by `handler`. */
async function harness(
  handler: (args: { topic: string }, task: TaskContext) => Promise<Record<string, unknown>>,
  layerOptions: Partial<Parameters<typeof createTaskLayer>[0]> & {
    /** What the auto-dispatch reports as the attempt's finality. Defaults to true. */
    dispatchIsFinalAttempt?: boolean;
  } = {},
): Promise<Harness> {
  const { dispatchIsFinalAttempt = true, ...layer } = layerOptions;
  const store = new MemoryTaskStore();
  // Bound below, once the layer exists.
  let execute: (taskId: string) => Promise<unknown> = async () => undefined;
  const dispatcher = new InlineTaskDispatcher((taskId) => execute(taskId));

  const tasks = createTaskLayer({ store, dispatcher, ...layer });
  execute = (taskId) => tasks.executeTask(taskId, { isFinalAttempt: dispatchIsFinalAttempt });

  // The transport validates the request's `mcp-protocol-version` header against this list, which
  // otherwise defaults to the 2025-era versions and rejects every 2026-07-28 request.
  const server = new McpServer(
    { name: "test", version: "1.0.0" },
    { supportedProtocolVersions: [TASKS_PROTOCOL_VERSION] },
  );
  tasks.registerTask(
    server,
    "generate_report",
    { description: "Generates a report", inputSchema: z.object({ topic: z.string() }) },
    handler,
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);

  let id = 0;
  const rpc: Rpc = async (method, params = {}, options = {}) => {
    const { withTasksCapability = true } = options;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": TASKS_PROTOCOL_VERSION,
      "mcp-method": method,
    };
    if (typeof params.name === "string") headers["mcp-name"] = params.name;
    if (typeof params.taskId === "string") headers["mcp-name"] = params.taskId;

    const response = await transport.handleRequest(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++id,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": TASKS_PROTOCOL_VERSION,
              "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" },
              "io.modelcontextprotocol/clientCapabilities": withTasksCapability
                ? { extensions: { [TASKS_EXTENSION]: {} } }
                : {},
            },
          },
        }),
      }),
    );
    return JSON.parse(await response.text());
  };

  return {
    rpc,
    tasks,
    store,
    dispatcher,
    close: async () => {
      await transport.close();
      store.clear();
    },
  };
}

/** A four-step handler that cooperates with cancellation, like the demo's. */
const steppedHandler =
  (steps = 4, stepMs = 20) =>
  async ({ topic }: { topic: string }, task: TaskContext) => {
    for (let step = 1; step <= steps; step++) {
      if (await task.isCancelled()) return {};
      await task.update(`Step ${step}/${steps}: processing ${topic}`);
      await sleep(stepMs);
    }
    return { content: [{ type: "text", text: `Report complete: ${topic}` }] };
  };

describe("createTaskLayer over MCP", () => {
  let live: Harness | undefined;
  afterEach(async () => {
    await live?.close();
    live = undefined;
  });

  it("answers tools/call with a task handle and no result", async () => {
    live = await harness(steppedHandler());
    const { result, error } = await live.rpc("tools/call", {
      name: "generate_report",
      arguments: { topic: "coffee trends" },
    });

    expect(error).toBeUndefined();
    expect(result?.resultType).toBe("task");
    expect(result?.status).toBe("working");
    expect(result?.statusMessage).toBe("Queued for durable execution");
    expect(typeof result?.taskId).toBe("string");
    expect(result?.ttlMs).toBe(300_000);
    expect(result?.pollIntervalMs).toBe(2_000);
    // The wire object must never leak the server's own bookkeeping.
    expect(result).not.toHaveProperty("name");
    expect(result).not.toHaveProperty("args");
    expect(result).not.toHaveProperty("dispatchId");
  });

  it("has the task durably readable the instant the handle is returned", async () => {
    live = await harness(steppedHandler());
    const { result } = await live.rpc("tools/call", {
      name: "generate_report",
      arguments: { topic: "coffee trends" },
    });
    // No awaiting, no sleeping: the create must have committed before the response went out.
    const stored = await live.store.get(String(result?.taskId));
    expect(stored?.taskId).toBe(result?.taskId);
    expect(stored?.name).toBe("generate_report");
    expect(stored?.args).toEqual({ topic: "coffee trends" });
  });

  it("rejects a client that has not declared the tasks extension", async () => {
    live = await harness(steppedHandler());
    const { result } = await live.rpc(
      "tools/call",
      { name: "generate_report", arguments: { topic: "tea" } },
      { withTasksCapability: false },
    );
    // McpServer flattens anything a tool callback throws into an isError result and drops the
    // code, so the refusal is a structured tool error rather than a JSON-RPC one.
    expect(result?.isError).toBe(true);
    expect(result?.resultType).not.toBe("task");
    expect(result?.structuredContent).toEqual({
      code: -32021,
      requiredCapabilities: { extensions: { "io.modelcontextprotocol/tasks": {} } },
    });
    expect(String((result?.content as { text: string }[])[0]?.text)).toMatch(/capability/i);
    // Nothing was created or dispatched for a call that was refused.
    expect(live.dispatcher.dispatched).toBe(0);
  });

  it("runs inline for such a client when configured to", async () => {
    live = await harness(steppedHandler(1, 1), { onMissingCapability: "run-inline" });
    const { result, error } = await live.rpc(
      "tools/call",
      { name: "generate_report", arguments: { topic: "tea" } },
      { withTasksCapability: false },
    );
    expect(error).toBeUndefined();
    expect(result?.resultType).not.toBe("task");
    expect(result?.content).toEqual([{ type: "text", text: "Report complete: tea" }]);
  });

  it("polls through to a completed task carrying its result inline", async () => {
    live = await harness(steppedHandler());
    const created = await live.rpc("tools/call", {
      name: "generate_report",
      arguments: { topic: "coffee trends" },
    });
    const taskId = String(created.result?.taskId);

    await live.dispatcher.drain();

    const polled = await live.rpc("tasks/get", { taskId });
    expect(polled.result?.resultType).toBe("complete");
    expect(polled.result?.status).toBe("completed");
    expect(polled.result?.statusMessage).toBe("Completed");
    expect(polled.result?.result).toEqual({
      content: [{ type: "text", text: "Report complete: coffee trends" }],
    });
  });

  it("reports progress between steps", async () => {
    live = await harness(steppedHandler(4, 40));
    const created = await live.rpc("tools/call", {
      name: "generate_report",
      arguments: { topic: "coffee trends" },
    });
    const taskId = String(created.result?.taskId);

    await sleep(50);
    const midway = await live.rpc("tasks/get", { taskId });
    expect(midway.result?.status).toBe("working");
    expect(String(midway.result?.statusMessage)).toMatch(/^Step \d\/4: processing coffee trends$/);

    await live.dispatcher.drain();
  });

  it("errors with -32602 for an unknown task id", async () => {
    live = await harness(steppedHandler());
    const { error } = await live.rpc("tasks/get", { taskId: "nope" });
    expect(error?.code).toBe(-32602);
    expect(error?.message).toMatch(/Unknown task/);
  });

  describe("cancellation", () => {
    it("flips the task to cancelled and stops the handler at its next check", async () => {
      live = await harness(steppedHandler(4, 60));
      const created = await live.rpc("tools/call", {
        name: "generate_report",
        arguments: { topic: "coffee trends" },
      });
      const taskId = String(created.result?.taskId);

      await sleep(70);
      const cancelled = await live.rpc("tasks/cancel", { taskId });
      expect(cancelled.result?.resultType).toBe("complete");
      expect(cancelled.result?.status).toBe("cancelled");

      await live.dispatcher.drain();

      // The handler ran on past the cancel and returned, but a terminal state is final: its
      // completion must not have overwritten the cancellation.
      const after = await live.rpc("tasks/get", { taskId });
      expect(after.result?.status).toBe("cancelled");
      expect(after.result?.result).toBeUndefined();
    });

    it("is idempotent", async () => {
      live = await harness(steppedHandler(4, 30));
      const created = await live.rpc("tools/call", {
        name: "generate_report",
        arguments: { topic: "x" },
      });
      const taskId = String(created.result?.taskId);

      await live.rpc("tasks/cancel", { taskId });
      const second = await live.rpc("tasks/cancel", { taskId });
      expect(second.error).toBeUndefined();
      expect(second.result?.status).toBe("cancelled");
      await live.dispatcher.drain();
    });

    it("never lets a completion overwrite a cancellation that landed first", async () => {
      // The race, made deterministic: the handler finishes its work, and the cancel arrives while
      // it is between finishing and being settled.
      live = await harness(async (_args, task) => {
        await live!.store.settle(task.taskId, { status: "cancelled" });
        return { content: [{ type: "text", text: "too late" }] };
      });
      const created = await live.rpc("tools/call", {
        name: "generate_report",
        arguments: { topic: "x" },
      });
      const taskId = String(created.result?.taskId);
      await live.dispatcher.drain();

      const after = await live.rpc("tasks/get", { taskId });
      expect(after.result?.status).toBe("cancelled");
      expect(after.result?.result).toBeUndefined();
    });
  });

  describe("at-least-once delivery", () => {
    it("ignores a redelivery of a task that already finished", async () => {
      let runs = 0;
      live = await harness(async () => {
        runs += 1;
        return { content: [{ type: "text", text: "done" }] };
      });
      const created = await live.rpc("tools/call", {
        name: "generate_report",
        arguments: { topic: "x" },
      });
      const taskId = String(created.result?.taskId);
      await live.dispatcher.drain();
      expect(runs).toBe(1);

      // The same message arriving twice is the contract, not a bug.
      await live.tasks.executeTask(taskId);
      await live.tasks.executeTask(taskId);
      expect(runs).toBe(1);
    });

    it("keeps a task retryable until the dispatcher's last attempt", async () => {
      let attempts = 0;
      live = await harness(
        async () => {
          attempts += 1;
          if (attempts < 3) throw new Error(`boom ${attempts}`);
          return { content: [{ type: "text", text: "eventually" }] };
        },
        { dispatchIsFinalAttempt: false },
      );
      const created = await live.rpc("tools/call", {
        name: "generate_report",
        arguments: { topic: "x" },
      });
      const taskId = String(created.result?.taskId);
      await live.dispatcher.drain();

      // Attempt 1 failed but must have left the task non-terminal, or the retries below would
      // all short-circuit on the redelivery guard.
      let current = await live.rpc("tasks/get", { taskId });
      expect(current.result?.status).toBe("working");

      await expect(live.tasks.executeTask(taskId, { isFinalAttempt: false })).rejects.toThrow(
        "boom 2",
      );
      expect((await live.rpc("tasks/get", { taskId })).result?.status).toBe("working");

      await live.tasks.executeTask(taskId, { isFinalAttempt: false });
      current = await live.rpc("tasks/get", { taskId });
      expect(current.result?.status).toBe("completed");
      expect(attempts).toBe(3);
    });

    it("settles failed on the final attempt", async () => {
      live = await harness(async () => {
        throw new Error("permanent");
      });
      const created = await live.rpc("tools/call", {
        name: "generate_report",
        arguments: { topic: "x" },
      });
      const taskId = String(created.result?.taskId);
      await live.dispatcher.drain();

      const after = await live.rpc("tasks/get", { taskId });
      expect(after.result?.status).toBe("failed");
      expect(after.result?.statusMessage).toBe("Execution failed");
      expect(after.result?.error).toMatchObject({ code: -32603, message: "permanent" });
    });
  });

  it("serves the task methods under custom names when asked", async () => {
    live = await harness(steppedHandler(1, 1), {
      methods: { get: "upstash/tasks.get", cancel: "upstash/tasks.cancel" },
    });
    const created = await live.rpc("tools/call", {
      name: "generate_report",
      arguments: { topic: "x" },
    });
    const taskId = String(created.result?.taskId);
    await live.dispatcher.drain();

    expect((await live.rpc("tasks/get", { taskId })).error?.code).toBe(-32601);
    const custom = await live.rpc("upstash/tasks.get", { taskId });
    expect(custom.result?.status).toBe("completed");
  });

  it("infers handler argument types from the input schema", async () => {
    // A compile-time assertion as much as a runtime one: `topic` is a string here because the
    // schema said so, with no annotation on the handler.
    live = await harness(async (args) => ({
      content: [{ type: "text", text: args.topic.toUpperCase() }],
    }));
    const created = await live.rpc("tools/call", {
      name: "generate_report",
      arguments: { topic: "coffee" },
    });
    await live.dispatcher.drain();
    const after = await live.rpc("tasks/get", { taskId: String(created.result?.taskId) });
    expect((after.result?.result as { content: { text: string }[] }).content[0]?.text).toBe(
      "COFFEE",
    );
  });
});

describe("wire shape", () => {
  it("keeps a WireTask assignable from what tasks/get returns", () => {
    const wire: WireTask = {
      taskId: "t",
      status: "working",
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      ttlMs: null,
    };
    expect(wire.ttlMs).toBeNull();
  });
});
