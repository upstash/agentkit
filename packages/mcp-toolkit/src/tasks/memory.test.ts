/**
 * The in-memory backends, which are also `McpTasks`' defaults: a server with nothing but
 * an MCP endpoint. Exercised end to end over a real `McpServer` and transport, in both modes, the
 * way a client would see it: start a task, then poll until it settles.
 */
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { McpTasks, type TaskMode } from "./core.js";
import type { McpTasksOptions, Task, TaskContext } from "./index.js";
import { InProcessDispatcher, MemoryTaskStore } from "./memory.js";
import { ManualDispatcher, sleep } from "../test-support.js";

const PROTOCOL_VERSION = "2026-07-28";
const TASKS = "io.modelcontextprotocol/tasks";

type Handler = (args: { topic: string }, task: TaskContext) => Promise<Record<string, unknown>>;
type Rpc = { result?: Record<string, unknown>; error?: { code: number; message: string } };

/** Four steps that report progress and stop when cancelled, like a real slow tool. */
const stepped =
  (seen: { cancelledAt?: number } = {}, stepMs = 15): Handler =>
  async ({ topic }, task) => {
    for (let step = 1; step <= 4; step++) {
      if (await task.isCancelled()) {
        seen.cancelledAt = step;
        return {};
      }
      await task.update(`Step ${step}/4: ${topic}`);
      await sleep(stepMs);
    }
    return { content: [{ type: "text", text: `Report: ${topic}` }] };
  };

/**
 * A server on the defaults: `new McpTasks({ principal })`, nothing else, and no execute
 * endpoint. `options` adds (a mode, short TTLs) but never a backend.
 */
function server(handler: Handler, options: { mode?: TaskMode; ttlMs?: number } = {}) {
  const tasks = new McpTasks({
    principal: () => "local",
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.ttlMs ? { defaults: { ttlMs: options.ttlMs, pollIntervalMs: 10 } } : {}),
  });
  tasks.registerTask(
    "generate_report",
    { description: "Generates a report.", inputSchema: z.object({ topic: z.string() }) },
    handler,
  );
  const mcp = createMcpHandler(() => {
    const instance = new McpServer({ name: "test", version: "1.0.0" });
    tasks.attach(instance);
    return instance;
  });

  let id = 0;
  const rpc = async (
    method: string,
    params: Record<string, unknown>,
    native: boolean,
  ): Promise<Rpc> => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      "mcp-method": method,
    };
    const name = params.name ?? params.taskId;
    if (typeof name === "string") headers["mcp-name"] = name;
    const response = await mcp.fetch(
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
              "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
              "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" },
              "io.modelcontextprotocol/clientCapabilities": native
                ? { extensions: { [TASKS]: {} } }
                : {},
            },
          },
        }),
      }),
    );
    return JSON.parse(await response.text()) as Rpc;
  };
  return { rpc, close: () => mcp.close() };
}

type Server = ReturnType<typeof server>;

/**
 * One client per flavour. `native` declares the extension and uses `tasks/get` / `tasks/cancel`;
 * `tools` declares nothing and uses `task_status` / `task_cancel`. Both return the task object.
 */
const clients = {
  native: (live: Server) => ({
    start: async () => {
      const { result } = await live.rpc(
        "tools/call",
        { name: "generate_report", arguments: { topic: "ferries" } },
        true,
      );
      expect(result?.resultType).toBe("task");
      return String(result?.taskId);
    },
    get: async (taskId: string) => {
      const { result, error } = await live.rpc("tasks/get", { taskId }, true);
      return error ? null : (result as Record<string, unknown>);
    },
    cancel: (taskId: string) => live.rpc("tasks/cancel", { taskId }, true),
  }),
  tools: (live: Server) => ({
    start: async () => {
      const { result } = await live.rpc(
        "tools/call",
        { name: "generate_report", arguments: { topic: "ferries" } },
        false,
      );
      expect(result?.resultType).toBe("complete");
      return String((result?.structuredContent as { taskId: string }).taskId);
    },
    get: async (taskId: string) => {
      const { result } = await live.rpc(
        "tools/call",
        { name: "task_status", arguments: { taskId } },
        false,
      );
      return result?.isError === true && !result.structuredContent
        ? null
        : (result?.structuredContent as Record<string, unknown>);
    },
    cancel: (taskId: string) =>
      live.rpc("tools/call", { name: "task_cancel", arguments: { taskId } }, false),
  }),
};

/** Polls until the task leaves `working`, the way a client does. */
async function settled(
  get: (taskId: string) => Promise<Record<string, unknown> | null>,
  taskId: string,
) {
  for (let i = 0; i < 200; i++) {
    const task = await get(taskId);
    if (task?.status !== "working") return task;
    await sleep(5);
  }
  throw new Error(`task ${taskId} never settled`);
}

describe.each([
  { flavour: "native" as const, mode: "native" as const },
  { flavour: "tools" as const, mode: "native" as const },
  { flavour: "tools" as const, mode: "tools" as const },
])("in-memory defaults: $flavour client, mode $mode", ({ flavour, mode }) => {
  let live: Server | undefined;
  afterEach(async () => {
    await live?.close();
    live = undefined;
  });

  it("runs the task in process, with progress, to completion", async () => {
    live = server(stepped(), { mode });
    const client = clients[flavour](live);
    const taskId = await client.start();

    let progress: unknown;
    for (let i = 0; i < 100 && !progress; i++) {
      const task = await client.get(taskId);
      if (String(task?.statusMessage).startsWith("Step")) progress = task?.statusMessage;
      else await sleep(2);
    }
    expect(progress).toMatch(/^Step \d\/4: ferries$/);

    const done = await settled(client.get, taskId);
    expect(done).toMatchObject({
      status: "completed",
      statusMessage: "Completed",
      result: { content: [{ type: "text", text: "Report: ferries" }] },
    });
  });

  it("cancels cooperatively: the handler sees isCancelled() and stops", async () => {
    const seen: { cancelledAt?: number } = {};
    live = server(stepped(seen, 20), { mode });
    const client = clients[flavour](live);
    const taskId = await client.start();
    await sleep(25);
    await client.cancel(taskId);
    expect(await client.get(taskId)).toMatchObject({
      status: "cancelled",
      statusMessage: "Cancelled by client",
    });
    await sleep(60);
    expect(seen.cancelledAt).toBeGreaterThan(1);
    expect(seen.cancelledAt).toBeLessThanOrEqual(4);
    // The late return did not overwrite the cancel.
    expect((await client.get(taskId))?.status).toBe("cancelled");
  });

  it("fails the task when the handler throws, without showing the model the error", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    live = server(
      async () => {
        throw new Error("pg: password auth failed");
      },
      { mode },
    );
    const client = clients[flavour](live);
    const taskId = await client.start();
    const failed = await settled(client.get, taskId);
    expect(failed).toMatchObject({
      status: "failed",
      error: { code: -32603, message: "The task handler threw an error" },
    });
    expect(JSON.stringify(failed)).not.toMatch(/password/);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("fails the task with the handler's own text when it returns a tool error", async () => {
    live = server(async () => ({ isError: true, content: [{ type: "text", text: "Read-only" }] }), {
      mode,
    });
    const client = clients[flavour](live);
    const failed = await settled(client.get, await client.start());
    expect(failed?.status).toBe("failed");
    expect(JSON.stringify(failed)).toMatch(/Read-only/);
  });

  it("forgets the task after its TTL, and tells a running handler it is over", async () => {
    const seen: { cancelledAt?: number } = {};
    live = server(stepped(seen, 30), { mode, ttlMs: 40 });
    const client = clients[flavour](live);
    const taskId = await client.start();
    expect((await client.get(taskId))?.status).toBe("working");
    await sleep(140);
    expect(await client.get(taskId)).toBeNull();
    expect(seen.cancelledAt).toBeDefined();
  });
});

describe("in-memory defaults", () => {
  it("needs no execute endpoint, and its execute handler says so", async () => {
    const dispatcher = new InProcessDispatcher();
    const tasks = new McpTasks({
      store: new MemoryTaskStore(),
      dispatcher,
      principal: () => "l",
    });
    const response = await tasks.createExecuteHandler()(new Request("http://localhost/x"));
    expect(response.status).toBe(404);
  });

  it("refuses a dispatcher without a store", () => {
    expect(
      () =>
        new McpTasks({
          dispatcher: new ManualDispatcher(),
          principal: () => "local",
        } as unknown as McpTasksOptions),
    ).toThrow(/store/);
  });

  it("serves one McpTasks per in-process dispatcher", () => {
    const dispatcher = new InProcessDispatcher();
    new McpTasks({ store: new MemoryTaskStore(), dispatcher, principal: () => "a" });
    expect(
      () => new McpTasks({ store: new MemoryTaskStore(), dispatcher, principal: () => "b" }),
    ).toThrow(/one per McpTasks/);
  });

  it("refuses to dispatch before it is connected", async () => {
    await expect(new InProcessDispatcher().dispatch({} as Task)).rejects.toThrow(/new McpTasks/);
  });

  it("warns once, in production only, when it falls back to memory", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const previous = process.env.NODE_ENV;
    try {
      vi.resetModules();
      const { McpTasks: Fresh } = await import("./core.js");
      const fresh = (options: McpTasksOptions) => new Fresh(options);
      process.env.NODE_ENV = "development";
      fresh({ principal: () => "local" });
      expect(warn).not.toHaveBeenCalled();

      process.env.NODE_ENV = "production";
      // Explicit backends, in-memory ones included, are a choice: no warning.
      fresh({
        store: new MemoryTaskStore(),
        dispatcher: new InProcessDispatcher(),
        principal: () => "local",
      });
      expect(warn).not.toHaveBeenCalled();

      fresh({ principal: () => "local" });
      fresh({ principal: () => "local" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/lost on restart.*RedisTaskStore/s);
    } finally {
      process.env.NODE_ENV = previous;
      warn.mockRestore();
    }
  });
});

describe("MemoryTaskStore", () => {
  const record = (ttlMs = 60_000): Task => {
    const now = new Date().toISOString();
    return {
      taskId: crypto.randomUUID(),
      status: "working",
      createdAt: now,
      lastUpdatedAt: now,
      ttlMs,
      pollIntervalMs: 1_000,
      name: "t",
      args: {},
      owner: "o",
    };
  };

  it("lets the first terminal write win, and ignores updates after it", async () => {
    const store = new MemoryTaskStore();
    const task = record();
    await store.create(task);
    await store.update(task.taskId, { statusMessage: "half" });
    expect((await store.get(task.taskId))?.statusMessage).toBe("half");
    expect((await store.settle(task.taskId, { status: "cancelled" }))?.status).toBe("cancelled");
    expect(
      (await store.settle(task.taskId, { status: "completed", result: { content: [] } }))?.status,
    ).toBe("cancelled");
    await store.update(task.taskId, { statusMessage: "late" });
    expect((await store.get(task.taskId))?.statusMessage).toBe("half");
  });

  it("expires a record ttlMs after creation, and hands out copies", async () => {
    const store = new MemoryTaskStore();
    const task = record(20);
    await store.create(task);
    const copy = await store.get(task.taskId);
    copy!.status = "completed";
    expect((await store.get(task.taskId))?.status).toBe("working");
    await sleep(30);
    expect(await store.get(task.taskId)).toBeNull();
    expect(await store.settle(task.taskId, { status: "failed" })).toBeNull();
  });
});
