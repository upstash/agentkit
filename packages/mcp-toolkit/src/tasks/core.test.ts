/**
 * The runtime, exercised through a real `McpServer` and a real transport — the requests below are
 * genuine JSON-RPC `tools/call`s over the wire, not direct calls into the layer.
 */
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import * as z from "zod";
import { createTaskLayer } from "./core.js";
import { InlineTaskDispatcher, MemoryTaskStore } from "./backends/memory.js";
import type { TaskContext, TaskLayer, TaskToolConfig, WireTask } from "./index.js";
import { CountingDispatcher, ManualDispatcher, sleep, userIdOf } from "../test-support.js";
import type { Task } from "./types.js";

const PROTOCOL_VERSION = "2026-07-28";

type ToolResult = {
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** `user` defaults to "alice"; `null` sends the request with no auth at all. */
type User = string | null | undefined;

type Call = (name: string, args: Record<string, unknown>, user?: User) => Promise<ToolResult>;

type Harness = {
  call: Call;
  /** Starts the report tool and returns the task id it answered with. */
  start: (topic?: string, user?: User) => Promise<string>;
  status: (taskId: string, user?: User) => Promise<ToolResult>;
  cancel: (taskId: string, user?: User) => Promise<ToolResult>;
  listTools: () => Promise<string[]>;
  tasks: TaskLayer;
  store: MemoryTaskStore;
  dispatcher: CountingDispatcher;
  close: () => Promise<void>;
};

type ReportArgs = { topic: string };

/** Every test identifies callers by the user id their auth carries. */
const principal = userIdOf;

/** Builds a server with one task tool backed by `handler`. */
async function harness(
  handler: (args: ReportArgs, task: TaskContext) => Promise<Record<string, unknown>>,
  layer: Partial<Parameters<typeof createTaskLayer>[0]> = {},
  tool: Partial<TaskToolConfig<z.ZodObject<{ topic: z.ZodString }>>> = {},
): Promise<Harness> {
  const store = new MemoryTaskStore();
  const dispatcher =
    (layer.dispatcher as CountingDispatcher | undefined) ?? new CountingDispatcher();
  const tasks = createTaskLayer({ store, principal, ...layer, dispatcher });

  // Defined once, the way module scope does it in an app.
  tasks.define(
    "generate_report",
    {
      description: "Generates a report.",
      inputSchema: z.object({ topic: z.string() }),
      ...tool,
    },
    handler,
  );

  // A fresh server per request, the way `createMcpHandler` serves stateless traffic — the same
  // path the demo uses. Registering on each one is cheap; the task layer's state is the store.
  const handlerFor = createMcpHandler(() => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    tasks.register(server);
    return server;
  });

  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown>, given?: User) => {
    const user = given === undefined ? "alice" : given;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      "mcp-method": method,
    };
    if (typeof params.name === "string") headers["mcp-name"] = params.name;
    const response = await handlerFor.fetch(
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
              // A client that declares nothing at all: the layer must not need any capability.
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      }),
      user
        ? { authInfo: { token: "t", clientId: "chatgpt", scopes: [], extra: { userId: user } } }
        : undefined,
    );
    const body = JSON.parse(await response.text());
    if (body.error) throw new Error(`${body.error.code}: ${body.error.message}`);
    return body.result as Record<string, unknown>;
  };

  const call: Call = async (name, args, user) =>
    (await rpc("tools/call", { name, arguments: args }, user)) as ToolResult;

  return {
    call,
    start: async (topic = "coffee trends", user) =>
      String((await call("generate_report", { topic }, user)).structuredContent?.taskId),
    status: (taskId, user) => call("task_status", { taskId }, user),
    cancel: (taskId, user) => call("task_cancel", { taskId }, user),
    listTools: async () =>
      ((await rpc("tools/list", {})).tools as { name: string }[]).map((t) => t.name),
    tasks,
    store,
    dispatcher,
    close: async () => {
      await handlerFor.close();
      store.clear();
    },
  };
}

/** A four-step handler that cooperates with cancellation, like the demo's. */
const steppedHandler =
  (steps = 4, stepMs = 20) =>
  async ({ topic }: ReportArgs, task: TaskContext) => {
    for (let step = 1; step <= steps; step++) {
      if (await task.isCancelled()) return {};
      await task.update(`Step ${step}/${steps}: processing ${topic}`);
      await sleep(stepMs);
    }
    return { content: [{ type: "text", text: `Report complete: ${topic}` }] };
  };

const text = (result: ToolResult) => (result.content ?? []).map((c) => c.text).join("\n");

describe("createTaskLayer over MCP", () => {
  let live: Harness | undefined;
  afterEach(async () => {
    await live?.close();
    live = undefined;
  });

  it("registers the task tool plus the shared status and cancel tools, once", async () => {
    live = await harness(steppedHandler());
    expect((await live.listTools()).sort()).toEqual(
      ["generate_report", "task_cancel", "task_status"].sort(),
    );
  });

  it("runs a task on an instance that never built a server", async () => {
    // The execute endpoint on a cold instance: the layer was created and the task defined at
    // module scope, but no MCP request — and so no `register` — ever happened there.
    const store = new MemoryTaskStore();
    const dispatcher = new ManualDispatcher();
    const coldInstance = createTaskLayer({ store, dispatcher, principal });
    coldInstance.define(
      "generate_report",
      { description: "Generates a report.", inputSchema: z.object({ topic: z.string() }) },
      async ({ topic }) => ({ content: [{ type: "text", text: topic }] }),
    );
    const now = new Date().toISOString();
    await store.create({
      taskId: "t1",
      status: "working",
      createdAt: now,
      lastUpdatedAt: now,
      ttlMs: null,
      name: "generate_report",
      args: { topic: "ferries" },
      owner: "alice",
    });
    await dispatcher.run("t1");
    expect((await store.get("t1"))?.status).toBe("completed");
    store.clear();
  });

  it("refuses to define the same task twice, or under a shared tool's name", () => {
    const tasks = createTaskLayer({
      store: new MemoryTaskStore(),
      dispatcher: new InlineTaskDispatcher(),
      principal,
    });
    const config = { description: "d", inputSchema: z.object({}) };
    tasks.define("a", config, async () => ({}));
    expect(() => tasks.define("a", config, async () => ({}))).toThrow(/already defined/);
    expect(() => tasks.define("task_status", config, async () => ({}))).toThrow(/reserved/);
  });

  it("answers the tool call with a task handle, as an ordinary tool result", async () => {
    live = await harness(steppedHandler());
    const result = await live.call("generate_report", { topic: "coffee trends" });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.status).toBe("working");
    expect(result.structuredContent?.statusMessage).toBe("Queued for durable execution");
    expect(typeof result.structuredContent?.taskId).toBe("string");
    expect(result.structuredContent?.pollIntervalMs).toBe(2_000);
    // The model is told what to do next, in words.
    expect(text(result)).toMatch(/task_status/);
    // The handle must never leak the server's own bookkeeping.
    expect(result.structuredContent).not.toHaveProperty("name");
    expect(result.structuredContent).not.toHaveProperty("args");
    expect(result.structuredContent).not.toHaveProperty("dispatchId");
    expect(result.structuredContent).not.toHaveProperty("owner");
  });

  it("has the task durably readable the instant the handle is returned", async () => {
    live = await harness(steppedHandler());
    const taskId = await live.start();
    // No awaiting, no sleeping: the create must have committed before the response went out.
    const stored = await live.store.get(taskId);
    expect(stored?.name).toBe("generate_report");
    expect(stored?.args).toEqual({ topic: "coffee trends" });
  });

  it("returns the handler's own result content from task_status once completed", async () => {
    live = await harness(steppedHandler());
    const taskId = await live.start();
    await live.dispatcher.drain();

    const polled = await live.status(taskId);
    expect(polled.structuredContent?.status).toBe("completed");
    expect(polled.structuredContent?.result).toEqual({
      content: [{ type: "text", text: "Report complete: coffee trends" }],
    });
    // The model reads the answer exactly as if the tool had run synchronously.
    expect(polled.content?.at(-1)).toEqual({
      type: "text",
      text: "Report complete: coffee trends",
    });
  });

  it("reports progress between steps", async () => {
    live = await harness(steppedHandler(4, 40));
    const taskId = await live.start();

    await sleep(50);
    const midway = await live.status(taskId);
    expect(midway.structuredContent?.status).toBe("working");
    expect(String(midway.structuredContent?.statusMessage)).toMatch(
      /^Step \d\/4: processing coffee trends$/,
    );
    expect(text(midway)).toMatch(/Check again/);
    await live.dispatcher.drain();
  });

  it("answers an unknown task id with a tool error, not a protocol error", async () => {
    live = await harness(steppedHandler());
    const result = await live.status("nope");
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Unknown task/);
  });

  describe("cancellation", () => {
    it("flips the task to cancelled and stops the handler at its next check", async () => {
      live = await harness(steppedHandler(4, 60));
      const taskId = await live.start();

      await sleep(70);
      const cancelled = await live.cancel(taskId);
      expect(cancelled.structuredContent?.status).toBe("cancelled");

      await live.dispatcher.drain();
      // A terminal state is final: the handler's late return must not overwrite it.
      const after = await live.status(taskId);
      expect(after.structuredContent?.status).toBe("cancelled");
      expect(after.structuredContent?.result).toBeUndefined();
    });

    it("is idempotent", async () => {
      live = await harness(steppedHandler(4, 30));
      const taskId = await live.start("x");
      await live.cancel(taskId);
      const second = await live.cancel(taskId);
      expect(second.isError).toBeFalsy();
      expect(second.structuredContent?.status).toBe("cancelled");
      await live.dispatcher.drain();
    });

    it("never lets a completion overwrite a cancellation that landed first", async () => {
      live = await harness(async (_args, task) => {
        await live!.store.settle(task.taskId, { status: "cancelled" });
        return { content: [{ type: "text", text: "too late" }] };
      });
      const taskId = await live.start("x");
      await live.dispatcher.drain();

      const after = await live.status(taskId);
      expect(after.structuredContent?.status).toBe("cancelled");
      expect(after.structuredContent?.result).toBeUndefined();
    });
  });

  describe("ownership", () => {
    it("hands principal the verified auth and the raw request, and accepts an async resolver", async () => {
      const seen: { userId: unknown; url: string | undefined }[] = [];
      live = await harness(steppedHandler(1, 1), {
        principal: async ({ auth, request }) => {
          seen.push({ userId: auth?.extra?.userId, url: request?.url });
          await sleep(1);
          return userIdOf({ auth });
        },
      });
      const taskId = await live.start("x", "alice");
      expect((await live.store.get(taskId))?.owner).toBe("alice");
      expect(seen[0]).toEqual({ userId: "alice", url: "http://localhost/mcp" });
      await live.dispatcher.drain();
    });

    it("lets the owner read and cancel its task", async () => {
      live = await harness(steppedHandler(4, 30));
      const taskId = await live.start("x", "alice");
      expect((await live.store.get(taskId))?.owner).toBe("alice");
      expect((await live.status(taskId, "alice")).structuredContent?.status).toBe("working");
      expect((await live.cancel(taskId, "alice")).structuredContent?.status).toBe("cancelled");
      await live.dispatcher.drain();
    });

    it("reports another caller's task as unknown, and refuses to cancel it", async () => {
      live = await harness(steppedHandler(4, 30));
      const taskId = await live.start("x", "alice");

      const peek = await live.status(taskId, "mallory");
      expect(peek.isError).toBe(true);
      expect(text(peek)).toMatch(/Unknown task/);

      const stop = await live.cancel(taskId, "mallory");
      expect(stop.isError).toBe(true);
      expect((await live.store.get(taskId))?.status).not.toBe("cancelled");

      // Nor does an anonymous caller get through.
      expect((await live.status(taskId, null)).isError).toBe(true);
      await live.dispatcher.drain();
    });

    it("refuses every call from a caller the principal cannot identify", async () => {
      live = await harness(steppedHandler(1, 1));
      const start = await live.call("generate_report", { topic: "x" }, null);
      expect(start.isError).toBe(true);
      expect(text(start)).toMatch(/Not authenticated/);
      expect(live.dispatcher.dispatched).toBe(0);

      const taskId = await live.start("x", "alice");
      expect(text(await live.status(taskId, null))).toMatch(/Not authenticated/);
      expect(text(await live.cancel(taskId, null))).toMatch(/Not authenticated/);
      await live.dispatcher.drain();
    });

    it("refuses when principal throws, or returns no usable id at runtime", async () => {
      for (const answer of [undefined, "", null, { id: "" }, 42]) {
        live = await harness(steppedHandler(1, 1), {
          // Plain JavaScript, or an `as string` that lied: the layer still fails closed.
          principal: (() => answer) as never,
        });
        const start = await live.call("generate_report", { topic: "x" }, "alice");
        expect(text(start)).toMatch(/Not authenticated/);
      }
      live = await harness(steppedHandler(1, 1), {
        principal: async () => {
          throw new Error("session store is down");
        },
      });
      expect(text(await live.call("generate_report", { topic: "x" }, "alice"))).toMatch(
        /Not authenticated/,
      );
      expect(live.dispatcher.dispatched).toBe(0);
    });

    it("never answers for a stored task without an owner", async () => {
      live = await harness(steppedHandler(1, 1));
      const taskId = await live.start("x", "alice");
      await live.dispatcher.drain();
      // A record written by something other than the layer, with no owner on it.
      const record = await live.store.get(taskId);
      live.store.clear();
      await live.store.create({ ...record!, owner: undefined as unknown as string });
      expect(text(await live.status(taskId, "alice"))).toMatch(/Unknown task/);
    });

    it("requires a principal", () => {
      expect(() =>
        createTaskLayer({
          store: new MemoryTaskStore(),
          dispatcher: new InlineTaskDispatcher(),
        } as unknown as Parameters<typeof createTaskLayer>[0]),
      ).toThrow(/principal/);
    });
  });

  it("starts a fresh task, with a random id, on every call", async () => {
    live = await harness(steppedHandler(1, 1));
    expect(await live.start("x")).not.toBe(await live.start("x"));
    await live.dispatcher.drain();
  });

  describe("at-least-once delivery", () => {
    it("ignores a redelivery of a task that already finished", async () => {
      let runs = 0;
      const manual = new ManualDispatcher();
      live = await harness(
        async () => {
          runs += 1;
          return { content: [{ type: "text", text: "done" }] };
        },
        { dispatcher: manual as never },
      );
      const taskId = await live.start("x");
      await manual.run(taskId);
      // The same message arriving twice is the contract, not a bug.
      await manual.run(taskId);
      await manual.run(taskId);
      expect(runs).toBe(1);
    });

    it("acknowledges a delivery for a task that no longer exists", async () => {
      const manual = new ManualDispatcher();
      live = await harness(steppedHandler(1, 1), { dispatcher: manual as never });
      // Expired or never created: a retry cannot fix that, so it must not throw.
      await expect(manual.run("gone")).resolves.toBeUndefined();
    });

    it("leaves a thrown task retryable rather than settling it failed", async () => {
      let attempts = 0;
      const manual = new ManualDispatcher();
      live = await harness(
        async () => {
          attempts += 1;
          if (attempts < 3) throw new Error(`boom ${attempts}`);
          return { content: [{ type: "text", text: "eventually" }] };
        },
        { dispatcher: manual as never },
      );
      const taskId = await live.start("x");
      // Only the transport decides that a failure is final.
      await expect(manual.run(taskId)).rejects.toThrow("boom 1");
      expect((await live.status(taskId)).structuredContent?.status).toBe("working");
      await expect(manual.run(taskId)).rejects.toThrow("boom 2");
      await manual.run(taskId);
      expect((await live.status(taskId)).structuredContent?.status).toBe("completed");
      expect(attempts).toBe(3);
    });

    it("settles failed once the dispatcher stops retrying", async () => {
      live = await harness(async () => {
        throw new Error("permanent");
      });
      const taskId = await live.start("x");
      await live.dispatcher.drain();

      const after = await live.status(taskId);
      expect(after.structuredContent?.status).toBe("failed");
      expect(after.structuredContent?.error).toMatchObject({ code: -32603, message: "permanent" });
      expect(text(after)).toMatch(/permanent/);
    });

    it("fails the task when it cannot be dispatched, instead of leaving it working", async () => {
      const manual = new ManualDispatcher();
      manual.failNext = new Error("queue unavailable");
      const settled: Task[] = [];
      live = await harness(steppedHandler(1, 1), {
        dispatcher: manual as never,
        onSettle: (task) => {
          settled.push(task);
        },
      });
      const result = await live.call("generate_report", { topic: "x" });
      expect(result.isError).toBe(true);
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({ status: "failed", statusMessage: "Could not be queued" });
    });
  });

  it("calls onSettle once and cancels the dispatch once, however often a task is cancelled", async () => {
    const manual = new ManualDispatcher();
    const settled: Task[] = [];
    live = await harness(steppedHandler(1, 1), {
      dispatcher: manual as never,
      onSettle: (task) => {
        settled.push(task);
      },
    });
    const taskId = await live.start("x");
    await live.cancel(taskId);
    await live.cancel(taskId);
    expect(settled.map((t) => t.status)).toEqual(["cancelled"]);
    expect(manual.cancelled).toEqual(["msg_1"]);
  });

  it("keeps ttlMs: null (unlimited) instead of falling back to the default", async () => {
    live = await harness(steppedHandler(1, 1), {}, { ttlMs: null });
    const result = await live.call("generate_report", { topic: "x" });
    expect(result.structuredContent?.ttlMs).toBeNull();
    await live.dispatcher.drain();
  });

  it("registers the shared tools under custom names when asked", async () => {
    live = await harness(steppedHandler(1, 1), {
      toolNames: { status: "upstash_task_status", cancel: "upstash_task_cancel" },
    });
    expect(await live.listTools()).toEqual(
      expect.arrayContaining(["upstash_task_status", "upstash_task_cancel"]),
    );
    const taskId = await live.start("x");
    await live.dispatcher.drain();
    expect((await live.call("upstash_task_status", { taskId })).structuredContent?.status).toBe(
      "completed",
    );
  });

  it("infers handler argument types from the input schema", async () => {
    // A compile-time assertion as much as a runtime one: `topic` is a string here because the
    // schema said so, with no annotation on the handler.
    live = await harness(async (args) => ({
      content: [{ type: "text", text: args.topic.toUpperCase() }],
    }));
    const taskId = await live.start("coffee");
    await live.dispatcher.drain();
    expect((await live.status(taskId)).content?.at(-1)?.text).toBe("COFFEE");
  });
});

describe("wire shape", () => {
  it("keeps a WireTask assignable from what task_status returns", () => {
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
