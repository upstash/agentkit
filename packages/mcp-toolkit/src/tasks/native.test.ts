/**
 * Native MCP Tasks (the `io.modelcontextprotocol/tasks` extension, protocol revision 2026-07-28),
 * exercised the way `core.test.ts` does: genuine JSON-RPC over a real `McpServer` and transport,
 * with the standard headers a 2026-07-28 client sends (`Mcp-Name` mirrors `params.taskId` on
 * `tasks/*`).
 */
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import * as z from "zod";
import { McpTasks, type TaskMode } from "./core.js";
import type { TaskContext } from "./index.js";
import { InProcessDispatcher, MemoryTaskStore } from "./memory.js";
import { ManualDispatcher, sleep, userIdOf } from "../test-support.js";

const PROTOCOL_VERSION = "2026-07-28";
const TASKS = "io.modelcontextprotocol/tasks";

/** Client capabilities with the Tasks extension declared, as Claude Code sends them. */
const WITH_TASKS = { extensions: { [TASKS]: {} } };

type Rpc = { result?: Record<string, unknown>; error?: { code: number; message: string } };

type Options = {
  mode?: TaskMode;
  dispatcher?: InProcessDispatcher | ManualDispatcher;
  handler?: (args: { topic: string }, task: TaskContext) => Promise<Record<string, unknown>>;
};

function harness(options: Options = {}) {
  const store = new MemoryTaskStore();
  const dispatcher = options.dispatcher ?? new InProcessDispatcher();
  const tasks = new McpTasks({
    store,
    dispatcher,
    principal: userIdOf,
    ...(options.mode ? { mode: options.mode } : {}),
  });
  tasks.registerTask(
    "generate_report",
    { description: "Generates a report.", inputSchema: z.object({ topic: z.string() }) },
    options.handler ??
      (async ({ topic }, task) => {
        await task.update(`Working on ${topic}`);
        await sleep(20);
        return { content: [{ type: "text", text: `Report: ${topic}` }] };
      }),
  );
  const mcp = createMcpHandler(() => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    tasks.attach(server);
    return server;
  });

  let id = 0;
  const rpc = async (
    method: string,
    params: Record<string, unknown> = {},
    { caps = WITH_TASKS as Record<string, unknown>, user = "alice" as string | null } = {},
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
              "io.modelcontextprotocol/clientCapabilities": caps,
            },
          },
        }),
      }),
      user
        ? { authInfo: { token: "t", clientId: "app", scopes: [], extra: { userId: user } } }
        : undefined,
    );
    return JSON.parse(await response.text()) as Rpc;
  };

  const start = async (opts?: Parameters<typeof rpc>[2]) =>
    rpc("tools/call", { name: "generate_report", arguments: { topic: "ferries" } }, opts);
  const get = (taskId: string, opts?: Parameters<typeof rpc>[2]) =>
    rpc("tasks/get", { taskId }, opts);

  return {
    rpc,
    start,
    get,
    store,
    /** Waits for every inline delivery to settle. */
    drain: async () => {
      if (dispatcher instanceof InProcessDispatcher) await dispatcher.drain();
    },
    close: async () => {
      await mcp.close();
    },
  };
}

type Harness = ReturnType<typeof harness>;

describe("native MCP Tasks", () => {
  let live: Harness | undefined;
  afterEach(async () => {
    await live?.close();
    live = undefined;
  });

  it("answers a call that declares the extension with a task, not a tool result", async () => {
    live = harness({ dispatcher: new ManualDispatcher() });
    const { result } = await live.start();
    expect(result).toMatchObject({
      resultType: "task",
      status: "working",
      statusMessage: "Queued",
      ttlMs: 86_400_000,
      pollIntervalMs: 2_000,
    });
    expect(typeof result?.taskId).toBe("string");
    expect(String(result?.taskId)).toMatch(/^[\x21-\x7e]{1,128}$/);
    expect(Date.parse(String(result?.createdAt))).not.toBeNaN();
    expect(Date.parse(String(result?.lastUpdatedAt))).not.toBeNaN();
    expect(result).not.toHaveProperty("structuredContent");
    // Server-only bookkeeping never leaves the store.
    for (const key of ["name", "args", "owner"]) expect(result).not.toHaveProperty(key);
    // Durable before the handle went out.
    expect((await live.store.get(String(result?.taskId)))?.owner).toBe("alice");
  });

  it("falls back to the tool-based handle for a client that does not declare the extension", async () => {
    live = harness({ dispatcher: new ManualDispatcher() });
    for (const caps of [{}, { extensions: {} }, { extensions: { "com.example/other": {} } }]) {
      const { result } = await live.start({ caps });
      expect(result?.resultType).toBe("complete");
      expect(result?.structuredContent).toMatchObject({ status: "working" });
      expect(JSON.stringify(result?.content)).toMatch(/task_status/);
    }
  });

  it("keeps task_status and task_cancel listed, for the fallback", async () => {
    live = harness();
    const { result } = await live.rpc("tools/list");
    const names = (result?.tools as { name: string }[]).map((tool) => tool.name).sort();
    expect(names).toEqual(["generate_report", "task_cancel", "task_status"]);
  });

  it("advertises the extension on server/discover", async () => {
    live = harness();
    const { result } = await live.rpc("server/discover");
    expect(result?.capabilities).toMatchObject({ extensions: { [TASKS]: {} } });
  });

  it("serves tasks/get from working to completed, with the tool result", async () => {
    live = harness();
    const taskId = String((await live.start()).result?.taskId);

    await sleep(5);
    const working = await live.get(taskId);
    expect(working.result).toMatchObject({
      resultType: "complete",
      taskId,
      status: "working",
      statusMessage: "Working on ferries",
      ttlMs: 86_400_000,
      pollIntervalMs: 2_000,
    });
    expect(working.result).not.toHaveProperty("result");

    await live.drain();
    const done = await live.get(taskId);
    expect(done.result).toMatchObject({
      resultType: "complete",
      taskId,
      status: "completed",
      statusMessage: "Completed",
      result: { content: [{ type: "text", text: "Report: ferries" }] },
    });
    expect(done.result).not.toHaveProperty("error");
  });

  it("reports a handler's tool error as a failed task whose message is the handler's text", async () => {
    live = harness({
      handler: async () => ({
        isError: true,
        content: [{ type: "text", text: "Workspace is read-only" }],
      }),
    });
    const taskId = String((await live.start()).result?.taskId);
    await live.drain();
    const { result } = await live.get(taskId);
    expect(result).toMatchObject({
      status: "failed",
      error: { code: -32603, message: "Workspace is read-only" },
    });
    expect(result).not.toHaveProperty("result");
  });

  it("reports a transport failure with its code and message, and keeps error.data in the store", async () => {
    const manual = new ManualDispatcher();
    live = harness({ dispatcher: manual });
    const taskId = String((await live.start()).result?.taskId);
    await manual.fail(taskId, {
      code: -32603,
      message: "Workflow run failed",
      data: { response: "pg: password auth failed" },
    });
    const { result } = await live.get(taskId);
    expect(result).toMatchObject({
      status: "failed",
      statusMessage: "Execution failed",
      error: { code: -32603, message: "Workflow run failed" },
    });
    expect(JSON.stringify(result)).not.toMatch(/password auth/);
  });

  it("cancels with tasks/cancel, cooperatively, and stops pending deliveries", async () => {
    const manual = new ManualDispatcher();
    live = harness({ dispatcher: manual });
    const taskId = String((await live.start()).result?.taskId);

    const cancel = await live.rpc("tasks/cancel", { taskId });
    expect(cancel.error).toBeUndefined();
    expect(cancel.result?.resultType).toBe("complete");
    expect(manual.cancelled).toEqual([taskId]);
    expect((await live.get(taskId)).result).toMatchObject({
      status: "cancelled",
      statusMessage: "Cancelled by client",
    });

    // A late delivery finds it settled; cancelling again is still fine.
    await manual.run(taskId);
    expect((await live.get(taskId)).result?.status).toBe("cancelled");
    expect((await live.rpc("tasks/cancel", { taskId })).result?.resultType).toBe("complete");
  });

  it("answers an unknown, malformed or foreign task id with -32602, identically", async () => {
    live = harness({ dispatcher: new ManualDispatcher() });
    const taskId = String((await live.start()).result?.taskId);
    let reads = 0;
    const get = live.store.get.bind(live.store);
    live.store.get = async (id) => {
      reads += 1;
      return get(id);
    };

    const unknown = crypto.randomUUID();
    for (const method of ["tasks/get", "tasks/cancel"]) {
      expect((await live.rpc(method, { taskId: unknown })).error?.code).toBe(-32602);
      expect((await live.rpc(method, { taskId: "not-a-task" })).error?.code).toBe(-32602);
      const foreign = await live.rpc(method, { taskId }, { user: "mallory" });
      expect(foreign.error?.code).toBe(-32602);
      expect(foreign.error?.message).toBe(
        `Unknown task: ${taskId}. It may have expired, or the id may be wrong.`,
      );
      expect((await live.rpc(method, { taskId }, { user: null })).error?.code).toBe(-32602);
    }
    // Malformed ids never reached the store; mallory's cancel left alice's task alone.
    expect(reads).toBe(4);
    expect((await live.get(taskId)).result?.status).toBe("working");
  });

  it("still serves a 2025-era client (initialize, then a tool-based handle)", async () => {
    const mcp = (body: Record<string, unknown>) =>
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
      });
    const parse = async (response: Response) => {
      const text = await response.text();
      const data = text.match(/^data: (.*)$/m)?.[1] ?? text;
      return JSON.parse(data) as Rpc;
    };
    // Its own server: the harness speaks 2026-07-28 only. Native mode registers `tasks/get` and
    // the extension capability on every instance, and a legacy instance must still start.
    const store = new MemoryTaskStore();
    const tasks = new McpTasks({
      store,
      dispatcher: new ManualDispatcher(),
      principal: () => "local",
    });
    tasks.registerTask("t", { description: "d", inputSchema: z.object({}) }, async () => ({}));
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: "test", version: "1.0.0" });
      tasks.attach(server);
      return server;
    });
    const init = await parse(
      await handler.fetch(
        mcp({
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "old", version: "1" },
          },
        }),
      ),
    );
    expect(init.error).toBeUndefined();
    const call = await parse(
      await handler.fetch(mcp({ method: "tools/call", params: { name: "t", arguments: {} } })),
    );
    expect(call.result?.structuredContent).toMatchObject({ status: "working" });
    await handler.close();
  });

  it("does not serve tasks/update (no input_required yet)", async () => {
    live = harness({ dispatcher: new ManualDispatcher() });
    const taskId = String((await live.start()).result?.taskId);
    const update = await live.rpc("tasks/update", { taskId, inputResponses: {} });
    expect(update.error?.code).toBe(-32601);
  });

  describe('mode: "tools"', () => {
    it("ignores the extension and answers with the tool-based handle", async () => {
      live = harness({ mode: "tools", dispatcher: new ManualDispatcher() });
      const { result } = await live.start();
      expect(result?.resultType).toBe("complete");
      expect(result?.structuredContent).toMatchObject({ status: "working" });
    });

    it("neither advertises the extension nor serves tasks/*", async () => {
      live = harness({ mode: "tools", dispatcher: new ManualDispatcher() });
      const discover = await live.rpc("server/discover");
      expect(JSON.stringify(discover.result?.capabilities ?? {})).not.toContain(TASKS);
      const handle = (await live.start()).result?.structuredContent as { taskId: string };
      expect((await live.get(handle.taskId)).error?.code).toBe(-32601);
    });
  });

  it("refuses an unknown mode", () => {
    expect(
      () =>
        new McpTasks({
          store: new MemoryTaskStore(),
          dispatcher: new InProcessDispatcher(),
          principal: userIdOf,
          mode: "both" as TaskMode,
        }),
    ).toThrow(/mode/);
  });
});
