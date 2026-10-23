/**
 * Asking the user from a task (`task.elicit`, `input_required`, `tasks/update`), over a real
 * `McpServer` and transport, on every backend that supports it: in memory (the default), Redis +
 * the in-process dispatcher, and Workflow (driven through a replaying stand-in for the engine).
 * QStash doesn't support it: `task.elicit` is not on its `task` type, and fails the task at runtime.
 */
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { Client as QStashClient } from "@upstash/qstash";
import type { WorkflowContext } from "@upstash/workflow";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as z from "zod";
import { QStashDispatcher, RedisTaskStore } from "./backends/qstash.js";
import { inputEventId, WorkflowDispatcher, workflowRoute } from "./backends/workflow.js";
import { McpTasks, type TaskHandler } from "./core.js";
import { InProcessDispatcher, MemoryTaskStore } from "./memory.js";
import type {
  TaskContext,
  TaskDispatcher,
  TaskElicit,
  TaskEndpoints,
  TaskInputWait,
  TaskStore,
} from "./types.js";
import {
  cleanupKeys,
  hasRedisCreds,
  ManualDispatcher,
  qstashRequest,
  sleep,
  testReceiver,
  testRedis,
  uniquePrefix,
  userIdOf,
} from "../test-support.js";

const PROTOCOL_VERSION = "2026-07-28";
const TASKS = "io.modelcontextprotocol/tasks";
const WITH_TASKS = { extensions: { [TASKS]: {} } };
const URL = "https://example.com/api/workflow";

type Rpc = { result?: Record<string, unknown>; error?: { code: number; message: string } };
type Handler = TaskHandler<{ item: string }, true>;

const publishSchema = z.object({ publish: z.boolean(), note: z.string().optional() });

/** Asks once, then reports what it was told. */
const askToPublish: Handler = async ({ item }, task) => {
  await task.update(`Preparing ${item}`);
  const answer = await task.elicit({
    message: `Publish ${item}?`,
    requestedSchema: publishSchema,
  });
  const text =
    answer.action === "accept"
      ? `${item}: ${answer.content.publish ? "published" : "kept"}${answer.content.note ? ` (${answer.content.note})` : ""}`
      : `${item}: ${answer.action}`;
  return { content: [{ type: "text", text }] };
};

/** An MCP endpoint over `tasks`, and a client that speaks to it as `user`. */
function endpoint(tasks: Pick<McpTasks, "attach">) {
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
  const start = async (opts?: Parameters<typeof rpc>[2]) => {
    const { result } = await rpc(
      "tools/call",
      { name: "publish", arguments: { item: "post-1" } },
      opts,
    );
    return String(result?.taskId ?? (result?.structuredContent as { taskId: string }).taskId);
  };
  const get = (taskId: string, opts?: Parameters<typeof rpc>[2]) =>
    rpc("tasks/get", { taskId }, opts);
  const update = (taskId: string, inputResponses: unknown, opts?: Parameters<typeof rpc>[2]) =>
    rpc("tasks/update", { taskId, inputResponses }, opts);
  /** Polls `tasks/get` until the status is one of `statuses`. */
  const until = async (taskId: string, ...statuses: string[]) => {
    for (let i = 0; i < 400; i++) {
      const { result, error } = await get(taskId);
      if (error) return { error };
      if (statuses.includes(String(result?.status))) return result!;
      await sleep(10);
    }
    throw new Error(`task ${taskId} never reached ${statuses.join("/")}`);
  };
  return { rpc, start, get, update, until, close: () => mcp.close() };
}

const accept = (content: Record<string, string | number | boolean | string[]>) => ({
  "elicit-1": { action: "accept" as const, content },
});

// ---------------------------------------------------------------------------------------------
// The behaviour every supporting backend shares

type Backend = {
  label: string;
  make: (
    handler: Handler,
    options?: { ttlMs?: number },
  ) => Promise<{
    live: ReturnType<typeof endpoint>;
    store: TaskStore;
    /** Resolves once nothing is running or waiting any more. */
    idle: () => Promise<void>;
    /** Called once per run of the handler's prefix (work before the question). */
    cleanup?: () => Promise<void>;
  }>;
};

function inMemory(): Backend {
  return {
    label: "in memory (the defaults)",
    make: async (handler, options = {}) => {
      const store = new MemoryTaskStore();
      const dispatcher = new InProcessDispatcher();
      const tasks = new McpTasks({
        store,
        dispatcher,
        principal: userIdOf,
        defaults: { pollIntervalMs: 20, ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}) },
      });
      tasks.registerTask(
        "publish",
        { description: "Publishes.", inputSchema: z.object({ item: z.string() }) },
        handler,
      );
      return { live: endpoint(tasks), store, idle: () => dispatcher.drain() };
    },
  };
}

function redisInProcess(): Backend & { cleanupAll: () => Promise<void> } {
  const redis = testRedis();
  const prefix = uniquePrefix("input");
  return {
    label: "Redis store, in-process dispatcher",
    cleanupAll: () => cleanupKeys(redis, prefix),
    make: async (handler, options = {}) => {
      const store = new RedisTaskStore({ redis, prefix });
      const dispatcher = new InProcessDispatcher();
      const tasks = new McpTasks({
        store,
        dispatcher,
        principal: userIdOf,
        defaults: { pollIntervalMs: 50, ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}) },
      });
      tasks.registerTask(
        "publish",
        { description: "Publishes.", inputSchema: z.object({ item: z.string() }) },
        handler,
      );
      return { live: endpoint(tasks), store, idle: () => dispatcher.drain() };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// A stand-in for the Workflow engine: it replays the route from the top on every invocation,
// executes one new step per invocation, keeps the journal, and parks a run on `waitForEvent`
// until `notify` (or the timeout). It drives the real `workflowRoute` and `WorkflowDispatcher`.

const ABORT = new Error("workflow step boundary");

class FakeRun {
  readonly journal = new Map<string, unknown>();
  waiting: { name: string; eventId: string; timer: ReturnType<typeof setTimeout> } | undefined;
  /** Events notified before anyone waited on them (Workflow's lookback). */
  readonly early = new Set<string>();
  done = false;
  cancelled = false;
  invocations = 0;
  private loop: Promise<void> = Promise.resolve();

  constructor(
    private readonly route: (context: WorkflowContext<{ taskId?: string }>) => Promise<void>,
    private readonly taskId: string,
  ) {}

  kick(): void {
    this.loop = this.loop.then(async () => {
      while (!this.done && !this.cancelled && !this.waiting) await this.invoke();
    });
  }

  settled(): Promise<void> {
    return this.loop;
  }

  notify(eventId: string): void {
    const waiting = this.waiting;
    if (!waiting || waiting.eventId !== eventId) {
      this.early.add(eventId);
      return;
    }
    clearTimeout(waiting.timer);
    this.journal.set(waiting.name, { timeout: false, eventData: undefined });
    this.waiting = undefined;
    this.kick();
  }

  cancel(): void {
    this.cancelled = true;
    if (this.waiting) clearTimeout(this.waiting.timer);
    this.waiting = undefined;
  }

  private async invoke(): Promise<void> {
    this.invocations += 1;
    let stepped = false;
    const executor = { executingStep: false as string | false };
    const context = {
      requestPayload: { taskId: this.taskId },
      executor,
      run: async (name: string, fn: () => Promise<unknown>) => {
        if (this.journal.has(name)) return this.journal.get(name);
        if (stepped) throw ABORT;
        executor.executingStep = name;
        let value: unknown;
        try {
          value = await fn();
        } finally {
          executor.executingStep = false;
        }
        // Results go through JSON, as in Workflow.
        this.journal.set(name, value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
        stepped = true;
        throw ABORT;
      },
      waitForEvent: async (name: string, eventId: string, options: { timeout: number }) => {
        if (this.journal.has(name)) return this.journal.get(name);
        // What QStash accepts (it answers 400 to anything else, and the run stops).
        if (!/^[\w.-]+$/.test(eventId)) throw new Error(`invalid eventId ${eventId}`);
        if (stepped) throw ABORT;
        if (this.early.delete(eventId)) {
          this.journal.set(name, { timeout: false, eventData: undefined });
          throw ABORT;
        }
        const timer = setTimeout(() => {
          this.journal.set(name, { timeout: true, eventData: undefined });
          this.waiting = undefined;
          this.kick();
        }, options.timeout * 1000);
        this.waiting = { name, eventId, timer };
        throw ABORT;
      },
    };
    try {
      await this.route(context as never);
      this.done = true;
    } catch (error) {
      if (error !== ABORT) throw error;
    }
  }
}

function workflow(): Backend & { runs: Map<string, FakeRun>; notified: string[] } {
  const runs = new Map<string, FakeRun>();
  const notified: string[] = [];
  return {
    label: "Workflow",
    runs,
    notified,
    make: async (handler, options = {}) => {
      let route: ((context: WorkflowContext<{ taskId?: string }>) => Promise<void>) | undefined;
      const client = {
        trigger: async ({
          body,
          workflowRunId,
        }: {
          body: { taskId: string };
          workflowRunId: string;
        }) => {
          const run = new FakeRun(route!, body.taskId);
          runs.set(`wfr_${workflowRunId}`, run);
          run.kick();
          return { workflowRunId: `wfr_${workflowRunId}` };
        },
        cancel: async (runId: string) => {
          runs.get(runId)?.cancel();
          return { cancelled: 1 };
        },
        notify: async ({ eventId, workflowRunId }: { eventId: string; workflowRunId: string }) => {
          notified.push(eventId);
          runs.get(workflowRunId)?.notify(eventId);
          return [];
        },
      };
      // Captures the endpoints the real route is built with.
      class Captured extends WorkflowDispatcher {
        override createExecuteHandler(endpoints: TaskEndpoints<never>) {
          route = workflowRoute(endpoints);
          return super.createExecuteHandler(endpoints);
        }
      }
      const store = new MemoryTaskStore();
      const tasks = new McpTasks({
        store,
        dispatcher: new Captured({ url: URL, client: client as never }),
        principal: userIdOf,
        defaults: { pollIntervalMs: 20, ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}) },
      });
      tasks.registerTask(
        "publish",
        { description: "Publishes.", inputSchema: z.object({ item: z.string() }) },
        handler as never,
      );
      tasks.createExecuteHandler();
      return {
        live: endpoint(tasks),
        store,
        // Until every run has finished or was cancelled: a parked run is still in flight.
        idle: async () => {
          for (const run of runs.values()) {
            while (!run.done && !run.cancelled) {
              await run.settled();
              if (run.waiting) await sleep(10);
            }
          }
        },
      };
    },
  };
}

const backends: Backend[] = [inMemory(), workflow()];
const redisBackend = hasRedisCreds ? redisInProcess() : undefined;
if (redisBackend) backends.push(redisBackend);

afterAll(async () => {
  await redisBackend?.cleanupAll();
});

for (const backend of backends) {
  describe(`task.elicit: ${backend.label}`, () => {
    let live: ReturnType<typeof endpoint> | undefined;
    afterEach(async () => {
      await live?.close();
      live = undefined;
    });

    it("asks, waits in input_required, and completes with the answer", async () => {
      const made = await backend.make(askToPublish);
      live = made.live;
      const taskId = await live.start();

      const waiting = await live.until(taskId, "input_required");
      expect(waiting).toMatchObject({
        resultType: "complete",
        taskId,
        status: "input_required",
        statusMessage: "Publish post-1?",
        inputRequests: {
          "elicit-1": {
            method: "elicitation/create",
            params: {
              mode: "form",
              message: "Publish post-1?",
              requestedSchema: { type: "object", properties: { publish: { type: "boolean" } } },
            },
          },
        },
      });
      // The answers never reach the wire.
      expect(waiting).not.toHaveProperty("inputResponses");

      const update = await live.update(taskId, accept({ publish: true, note: "ok" }));
      expect(update.error).toBeUndefined();
      expect(update.result).toMatchObject({ resultType: "complete" });

      const done = await live.until(taskId, "completed");
      expect(done).toMatchObject({
        status: "completed",
        result: { content: [{ type: "text", text: "post-1: published (ok)" }] },
      });
      expect(done).not.toHaveProperty("inputRequests");
      await made.idle();
    });

    for (const action of ["decline", "cancel"] as const) {
      it(`hands the handler a ${action}`, async () => {
        const made = await backend.make(askToPublish);
        live = made.live;
        const taskId = await live.start();
        await live.until(taskId, "input_required");
        await live.update(taskId, { "elicit-1": { action } });
        expect(await live.until(taskId, "completed")).toMatchObject({
          result: { content: [{ type: "text", text: `post-1: ${action}` }] },
        });
        await made.idle();
      });
    }

    it("releases a waiting handler when the task is cancelled, and ignores a late answer", async () => {
      let after = 0;
      const made = await backend.make(async (args, task) => {
        const result = await askToPublish(args, task);
        after += 1;
        return result;
      });
      live = made.live;
      const taskId = await live.start();
      await live.until(taskId, "input_required");

      expect((await live.rpc("tasks/cancel", { taskId })).result).toMatchObject({
        resultType: "complete",
      });
      await made.idle(); // would hang if the handler were still waiting
      expect(after).toBe(0);
      expect((await live.get(taskId)).result).toMatchObject({
        status: "cancelled",
        statusMessage: "Cancelled by client",
      });
      expect((await live.get(taskId)).result).not.toHaveProperty("inputRequests");

      const late = await live.update(taskId, accept({ publish: true }));
      expect(late.result).toMatchObject({ resultType: "complete" });
      expect((await made.store.get(taskId))?.status).toBe("cancelled");
      expect((await made.store.get(taskId))?.inputResponses).toBeUndefined();
    });

    it("stops a waiting handler when the task expires", async () => {
      let after = 0;
      const made = await backend.make(
        async (args, task) => {
          const result = await askToPublish(args, task);
          after += 1;
          return result;
        },
        { ttlMs: 1_200 },
      );
      live = made.live;
      const taskId = await live.start();
      await live.until(taskId, "input_required");
      await made.idle();
      expect(after).toBe(0);
      expect((await live.get(taskId)).error?.code).toBe(-32602);
      expect((await live.update(taskId, accept({ publish: true }))).error?.code).toBe(-32602);
    }, 15_000);

    it("answers -32602 to a tasks/update from another user, or for an unknown or malformed id", async () => {
      const made = await backend.make(askToPublish);
      live = made.live;
      const taskId = await live.start();
      await live.until(taskId, "input_required");

      const foreign = await live.update(taskId, accept({ publish: true }), { user: "mallory" });
      expect(foreign.error).toEqual({
        code: -32602,
        message: `Unknown task: ${taskId}. It may have expired, or the id may be wrong.`,
      });
      expect(
        (await live.update(taskId, accept({ publish: true }), { user: null })).error?.code,
      ).toBe(-32602);
      expect((await live.update(crypto.randomUUID(), accept({ publish: true }))).error?.code).toBe(
        -32602,
      );
      expect((await live.update("not-a-task", accept({ publish: true }))).error?.code).toBe(-32602);
      // Mallory's answer was not taken.
      expect((await live.get(taskId)).result?.status).toBe("input_required");
      expect((await made.store.get(taskId))?.inputResponses).toBeUndefined();

      await live.rpc("tasks/cancel", { taskId });
      await made.idle();
    });

    it("refuses malformed inputResponses before storing anything", async () => {
      const made = await backend.make(askToPublish);
      live = made.live;
      const taskId = await live.start();
      await live.until(taskId, "input_required");

      const tooMany = Object.fromEntries(
        Array.from({ length: 17 }, (_, i) => [`k${i}`, { action: "decline" }]),
      );
      const cases: unknown[] = [
        undefined,
        { "elicit-1": { action: "maybe" } },
        { "elicit-1": { action: "accept", content: { publish: { nested: true } } } },
        // A wrapped envelope, which the SDK drops: never half-taken.
        { "elicit-1": { method: "elicitation/create", result: { action: "accept" } } },
        tooMany,
        { "elicit-1": { action: "accept", content: { publish: "x".repeat(70_000) } } },
        { ["k".repeat(65)]: { action: "decline" } },
      ];
      for (const inputResponses of cases) {
        const response = await live.update(taskId, inputResponses);
        expect(response.error?.code).toBe(-32602);
        expect(response.error?.message).toMatch(/inputResponses/);
      }
      expect((await live.get(taskId)).result?.status).toBe("input_required");
      expect((await made.store.get(taskId))?.inputResponses).toBeUndefined();

      // Unknown keys are ignored, and the task keeps waiting.
      expect((await live.update(taskId, { other: { action: "decline" } })).result).toMatchObject({
        resultType: "complete",
      });
      expect((await live.get(taskId)).result?.status).toBe("input_required");

      await live.update(taskId, accept({ publish: false }));
      expect(await live.until(taskId, "completed")).toMatchObject({
        result: { content: [{ type: "text", text: "post-1: kept" }] },
      });
      // Already answered: ignored.
      expect((await live.update(taskId, accept({ publish: true }))).result).toMatchObject({
        resultType: "complete",
      });
      expect((await made.store.get(taskId))?.inputResponses).toEqual(accept({ publish: false }));
      await made.idle();
    });

    it("fails the task when the accepted content doesn't match the form", async () => {
      const made = await backend.make(askToPublish);
      live = made.live;
      const taskId = await live.start();
      await live.until(taskId, "input_required");
      await live.update(taskId, accept({ publish: "yes please" }));
      expect(await live.until(taskId, "failed")).toMatchObject({
        status: "failed",
        error: { code: -32603, message: "The user's answer did not match the requested form." },
      });
      await made.idle();
    });

    it("asks several questions in turn, keyed by call order", async () => {
      const made = await backend.make(async (_args, task) => {
        const answers: string[] = [];
        for (const step of ["one", "two"]) {
          const answer = await task.elicit({
            message: `Step ${step}?`,
            requestedSchema: z.object({ ok: z.boolean() }),
          });
          answers.push(`${step}=${answer.action === "accept" ? answer.content.ok : answer.action}`);
        }
        return { content: [{ type: "text", text: answers.join(",") }] };
      });
      live = made.live;
      const taskId = await live.start();
      const first = await live.until(taskId, "input_required");
      expect(Object.keys(first.inputRequests as object)).toEqual(["elicit-1"]);
      await live.update(taskId, { "elicit-1": { action: "accept", content: { ok: true } } });
      // The first answer to the second question isn't confused with the first.
      let second = await live.until(taskId, "input_required");
      for (
        let i = 0;
        i < 100 && !Object.hasOwn((second.inputRequests as object | undefined) ?? {}, "elicit-2");
        i++
      ) {
        await sleep(10);
        second = (await live.get(taskId)).result!;
      }
      expect(Object.keys(second.inputRequests as object)).toEqual(["elicit-2"]);
      await live.update(taskId, { "elicit-2": { action: "decline" } });
      expect(await live.until(taskId, "completed")).toMatchObject({
        result: { content: [{ type: "text", text: "one=true,two=decline" }] },
      });
      await made.idle();
    });
  });
}

describe("task.elicit on Workflow", () => {
  it("runs the work before the question once, and resumes on the notified event", async () => {
    const backend = workflow();
    let prepared = 0;
    const made = await backend.make(async (args, task) => {
      const wf = task as unknown as TaskContext & TaskElicit & WorkflowContext;
      await wf.run("prepare", async () => {
        prepared += 1;
      });
      return askToPublish(args, task);
    });
    const live = made.live;
    const taskId = await live.start();
    await live.until(taskId, "input_required");
    const run = backend.runs.get(`wfr_${taskId}`)!;
    // Parked on the event, not holding an invocation.
    expect(run.waiting?.eventId).toBe(inputEventId(taskId, "elicit-1"));
    expect(run.waiting?.eventId).toMatch(/^[\w.-]+$/);

    await live.update(taskId, accept({ publish: true }));
    expect(backend.notified).toEqual([inputEventId(taskId, "elicit-1")]);
    await live.until(taskId, "completed");
    await made.idle();

    expect(prepared).toBe(1);
    expect(run.invocations).toBeGreaterThan(3); // replayed from the journal each time
    // The answer is in the journal, so a replay doesn't depend on the record.
    expect(run.journal.get("mcp-task:look:1:1")).toEqual({
      answer: { action: "accept", content: { publish: true } },
    });
    expect(run.journal.has("mcp-task:wait:elicit-1:1")).toBe(true);
    await live.close();
  });

  it("picks up an answer whose notify was lost, at the next look", async () => {
    const backend = workflow();
    const made = await backend.make(askToPublish, { ttlMs: 60_000 });
    const live = made.live;
    const taskId = await live.start();
    await live.until(taskId, "input_required");
    const run = backend.runs.get(`wfr_${taskId}`)!;
    // Answer straight into the store: no tasks/update, so no notify.
    await made.store.respond(taskId, accept({ publish: true }), "Answer received");
    // The wait's timeout (shortened here) ends the round; the look finds the answer.
    clearTimeout(run.waiting!.timer);
    run.journal.set(run.waiting!.name, { timeout: true });
    run.waiting = undefined;
    run.kick();
    await live.until(taskId, "completed");
    await made.idle();
    await live.close();
  });

  it("refuses an elicit inside task.run", async () => {
    const backend = workflow();
    const made = await backend.make(async (_args, task) => {
      const wf = task as unknown as TaskContext & TaskElicit & WorkflowContext;
      await wf.run("inner", async () => {
        await task.elicit({ message: "?", requestedSchema: z.object({ ok: z.boolean() }) });
      });
      return {};
    });
    const taskId = await made.live.start();
    // The step throws, so Workflow retries it and finally runs the failure function.
    await expect(made.idle()).rejects.toThrow(/inside task.run/);
    expect((await made.store.get(taskId))?.status).not.toBe("completed");
    await made.live.close();
  });
});

describe("task.elicit limits", () => {
  it("fails a task that asks more than 16 questions", async () => {
    const { live, idle } = await inMemory().make(async (_args, task) => {
      for (let i = 0; i < 17; i++) {
        await task.elicit({ message: `${i}?`, requestedSchema: z.object({ ok: z.boolean() }) });
      }
      return {};
    });
    const taskId = await live.start();
    for (let i = 1; i <= 16; i++) {
      for (let tries = 0; tries < 200; tries++) {
        const { result } = await live.get(taskId);
        if (Object.hasOwn((result?.inputRequests as object | undefined) ?? {}, `elicit-${i}`))
          break;
        await sleep(5);
      }
      await live.update(taskId, { [`elicit-${i}`]: { action: "decline" } });
    }
    expect(await live.until(taskId, "failed")).toMatchObject({
      error: { message: "A task can ask at most 16 questions." },
    });
    await idle();
    await live.close();
  });

  it("refuses a second question while one is open", async () => {
    const { live, idle, store } = await inMemory().make(async (_args, task) => {
      const schema = z.object({ ok: z.boolean() });
      await Promise.all([
        task.elicit({ message: "a?", requestedSchema: schema }),
        task.elicit({ message: "b?", requestedSchema: schema }),
      ]);
      return {};
    });
    const taskId = await live.start();
    await idle();
    // In memory a throw fails the task, with the details kept out of the wire error.
    expect((await store.get(taskId))?.error?.data).toMatchObject({
      error: expect.stringMatching(/one question at a time/),
    });
    await live.close();
  });
});

describe("task.elicit with QStashDispatcher", () => {
  it("fails the task with a message that says which dispatchers can ask", async () => {
    const store = new MemoryTaskStore();
    const dispatcher = new QStashDispatcher({
      url: "https://example.com/api/execute",
      receiver: testReceiver(),
      qstash: { publishJSON: async () => ({ messageId: "m" }) } as unknown as QStashClient,
    });
    const tasks = new McpTasks({ store, dispatcher, principal: userIdOf });
    let after = false;
    tasks.registerTask(
      "publish",
      { description: "Publishes.", inputSchema: z.object({ item: z.string() }) },
      async (_args, task) => {
        // @ts-expect-error: not on `task` with QStashDispatcher. A plain-JS handler still gets a
        // clear failure at runtime.
        await task.elicit({ message: "?", requestedSchema: z.object({ ok: z.boolean() }) });
        after = true;
        return {};
      },
    );
    const live = endpoint(tasks);
    const taskId = await live.start();
    const execute = tasks.createExecuteHandler();
    const response = await execute(qstashRequest("https://example.com/api/execute", { taskId }));
    // Acknowledged: a retry can't fix it.
    expect(response.status).toBe(200);
    expect(after).toBe(false);
    expect((await live.get(taskId)).result).toMatchObject({
      status: "failed",
      error: {
        code: -32603,
        message:
          "task.elicit needs a dispatcher that can wait for the user's answer, and " +
          "QStashDispatcher can't. Use WorkflowDispatcher, or the in-memory backends, for " +
          "tasks that ask the user.",
      },
    });
    await live.close();
  });

  it("offers task.elicit only where it works (types)", () => {
    const schema = z.object({ ok: z.boolean() });
    const handler = { description: "d", inputSchema: z.object({}) };

    // The default (in memory), and the in-process dispatcher with any store.
    new McpTasks({ principal: () => "local" }).registerTask("a", handler, async (_a, task) => {
      const answer = await task.elicit({ message: "?", requestedSchema: schema });
      if (answer.action === "accept") {
        const ok: boolean = answer.content.ok;
        void ok;
      }
      return {};
    });
    new McpTasks({ store: new MemoryTaskStore(), principal: () => "local" }).registerTask(
      "b",
      handler,
      async (_a, task) => (await task.elicit({ message: "?", requestedSchema: schema }), {}),
    );
    new McpTasks({
      store: new MemoryTaskStore(),
      dispatcher: new InProcessDispatcher(),
      principal: () => "local",
    }).registerTask("c", handler, async (_a, task) => {
      await task.elicit({ message: "?", requestedSchema: schema });
      return {};
    });
    // Workflow: elicit next to the Workflow API.
    new McpTasks({
      store: new MemoryTaskStore(),
      dispatcher: new WorkflowDispatcher({ url: URL }),
      principal: () => "local",
    }).registerTask("d", handler, async (_a, task) => {
      await task.run("step", async () => 1);
      await task.elicit({ message: "?", requestedSchema: schema });
      return {};
    });
    // QStash: not there at all.
    new McpTasks({
      store: new MemoryTaskStore(),
      dispatcher: new QStashDispatcher({ url: URL }),
      principal: () => "local",
    }).registerTask("e", handler, async (_a, task) => {
      // @ts-expect-error: QStashDispatcher can't wait for the user.
      void task.elicit;
      return {};
    });
    // A test dispatcher that doesn't declare it either.
    new McpTasks({
      store: new MemoryTaskStore(),
      dispatcher: new ManualDispatcher(),
      principal: () => "local",
    }).registerTask("f", handler, async (_a, task) => {
      // @ts-expect-error: not declared by the dispatcher.
      void task.elicit;
      return {};
    });
  });

  it("reads CanAsk and the context off a custom dispatcher (types)", () => {
    const handler = { description: "d", inputSchema: z.object({}) };
    type Extra = { region: string };
    const core = {
      dispatch: async () => undefined,
      cancel: async () => undefined,
      createExecuteHandler: () => async () => new Response(),
    };
    // Doesn't opt in: its context, but no elicit.
    class Plain implements TaskDispatcher<false, Extra> {
      dispatch = core.dispatch;
      cancel = core.cancel;
      createExecuteHandler(_endpoints: TaskEndpoints<Extra>) {
        return core.createExecuteHandler();
      }
    }
    new McpTasks({
      store: new MemoryTaskStore(),
      dispatcher: new Plain(),
      principal: () => "local",
    }).registerTask("g", handler, async (_a, task) => {
      const region: string = task.region;
      void region;
      // @ts-expect-error: a dispatcher that doesn't opt in has no elicit.
      void task.elicit;
      return {};
    });
    // Opts in: elicit next to its context.
    class Asking extends Plain implements TaskDispatcher<true, Extra> {
      async waitForInput(_wait: TaskInputWait, _context: Extra) {}
      async resume() {}
    }
    new McpTasks({
      store: new MemoryTaskStore(),
      dispatcher: new Asking(),
      principal: () => "local",
    }).registerTask("h", handler, async (_a, task) => {
      void task.region;
      await task.elicit({ message: "?", requestedSchema: z.object({ ok: z.boolean() }) });
      return {};
    });
    // `true` requires the waits; `false` rules them out.
    // @ts-expect-error: TaskDispatcher<true> without waitForInput / resume.
    const missing: TaskDispatcher<true> = core;
    // @ts-expect-error: a non-asking dispatcher can't have waitForInput.
    const extra: TaskDispatcher = { ...core, waitForInput: async () => undefined };
    void missing;
    void extra;
  });
});

describe("task.elicit for clients without native tasks", () => {
  const TOOLS_ONLY = {} as Record<string, unknown>;
  const WITH_ELICITATION = { elicitation: { form: {} } } as Record<string, unknown>;

  const status = (
    live: ReturnType<typeof endpoint>,
    taskId: string,
    caps: Record<string, unknown>,
    extra: Record<string, unknown> = {},
    user = "alice",
  ) =>
    live.rpc(
      "tools/call",
      { name: "task_status", arguments: { taskId }, ...extra },
      { caps, user },
    );

  async function waitingTask() {
    const made = await inMemory().make(askToPublish);
    const taskId = await made.live.start({ caps: TOOLS_ONLY });
    for (let i = 0; i < 200; i++) {
      if ((await made.store.get(taskId))?.status === "input_required") break;
      await sleep(5);
    }
    return { ...made, taskId };
  }

  it("asks the user through task_status's own input_required, when the client can show a form", async () => {
    const { live, taskId, idle } = await waitingTask();
    const asked = await status(live, taskId, WITH_ELICITATION);
    expect(asked.result).toMatchObject({
      resultType: "input_required",
      inputRequests: {
        "elicit-1": { method: "elicitation/create", params: { message: "Publish post-1?" } },
      },
    });

    // The client shows the form and retries the same call with the user's answers.
    const retried = await status(live, taskId, WITH_ELICITATION, {
      inputResponses: accept({ publish: true }),
    });
    expect(retried.result?.resultType).toBe("complete");
    expect(retried.result?.structuredContent).toMatchObject({ taskId });
    await idle();
    const done = await status(live, taskId, WITH_ELICITATION);
    expect(done.result?.structuredContent).toMatchObject({ status: "completed" });
    expect(JSON.stringify(done.result?.content)).toContain("post-1: published");
    await live.close();
  });

  it("tells the model the question is for the user, when the client can't show it", async () => {
    const { live, taskId, idle } = await waitingTask();
    const { result } = await status(live, taskId, TOOLS_ONLY);
    expect(result?.resultType).toBe("complete");
    expect(result?.structuredContent).toMatchObject({
      status: "input_required",
      statusMessage: "Publish post-1?",
      inputRequests: { "elicit-1": { method: "elicitation/create" } },
    });
    expect(result?.structuredContent).not.toHaveProperty("inputResponses");
    const text = JSON.stringify(result?.content);
    expect(text).toMatch(/Only the user can answer it/);
    expect(text).toMatch(/task_cancel/);
    // There is no tool for the model to answer with.
    const tools = (await live.rpc("tools/list", {}, { caps: TOOLS_ONLY })).result?.tools as {
      name: string;
    }[];
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "publish",
      "task_cancel",
      "task_status",
    ]);

    await live.rpc(
      "tools/call",
      { name: "task_cancel", arguments: { taskId } },
      { caps: TOOLS_ONLY },
    );
    await idle();
    await live.close();
  });

  it("takes no answer from another user's retry, and refuses a malformed one", async () => {
    const { live, taskId, idle, store } = await waitingTask();
    const foreign = await status(
      live,
      taskId,
      WITH_ELICITATION,
      { inputResponses: accept({ publish: true }) },
      "mallory",
    );
    expect(foreign.result?.isError).toBe(true);
    expect(JSON.stringify(foreign.result?.content)).toMatch(/Unknown task/);
    const malformed = await status(live, taskId, WITH_ELICITATION, {
      inputResponses: { "elicit-1": { action: "maybe" } },
    });
    expect(malformed.result?.isError).toBe(true);
    expect((await store.get(taskId))?.inputResponses).toBeUndefined();
    expect((await store.get(taskId))?.status).toBe("input_required");
    await live.rpc("tasks/cancel", { taskId });
    await idle();
    await live.close();
  });

  it('works the same in mode: "tools"', async () => {
    const store = new MemoryTaskStore();
    const dispatcher = new InProcessDispatcher();
    const tasks = new McpTasks({ store, dispatcher, principal: userIdOf, mode: "tools" });
    tasks.registerTask(
      "publish",
      { description: "Publishes.", inputSchema: z.object({ item: z.string() }) },
      askToPublish,
    );
    const live = endpoint(tasks);
    const taskId = await live.start();
    for (let i = 0; i < 200 && (await store.get(taskId))?.status !== "input_required"; i++) {
      await sleep(5);
    }
    expect((await status(live, taskId, WITH_ELICITATION)).result?.resultType).toBe(
      "input_required",
    );
    expect((await live.update(taskId, accept({ publish: true }))).error?.code).toBe(-32601);
    await status(live, taskId, WITH_ELICITATION, { inputResponses: accept({ publish: true }) });
    await dispatcher.drain();
    expect((await store.get(taskId))?.status).toBe("completed");
    await live.close();
  });
});
