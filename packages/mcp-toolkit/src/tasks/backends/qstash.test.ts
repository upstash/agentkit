import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { QStashDispatcher, RedisTaskStore } from "./qstash.js";
import { UnknownTaskError, type Task, type TaskError } from "../types.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniquePrefix } from "../../test-support.js";

const makeTask = (overrides: Partial<Task> = {}): Task => {
  const now = new Date().toISOString();
  return {
    taskId: `task-${Math.random().toString(36).slice(2, 10)}`,
    status: "working",
    statusMessage: "Queued for durable execution",
    createdAt: now,
    lastUpdatedAt: now,
    ttlMs: 300_000,
    pollIntervalMs: 2_000,
    name: "generate_report",
    args: { topic: "coffee trends" },
    owner: "alice",
    ...overrides,
  };
};

describe.skipIf(!hasRedisCreds)("RedisTaskStore (real Redis)", () => {
  const redis = testRedis();
  const prefix = uniquePrefix("store");
  const store = new RedisTaskStore({ redis, prefix });

  afterAll(async () => {
    await cleanupKeys(redis, prefix);
  });

  it("round-trips a task exactly, including values that look like other JSON types", async () => {
    // "123" and "true" are the trap: an unencoded write comes back as a number and a boolean,
    // because @upstash/redis JSON-parses responses.
    const task = makeTask({
      statusMessage: "123",
      args: { topic: "true", nested: { count: 4 }, list: [1, 2, 3] },
    });
    await store.create(task);

    const loaded = await store.get(task.taskId);
    expect(loaded).not.toBeNull();
    expect(loaded?.statusMessage).toBe("123");
    expect(typeof loaded?.statusMessage).toBe("string");
    expect(loaded?.args).toEqual({ topic: "true", nested: { count: 4 }, list: [1, 2, 3] });
    expect(loaded?.ttlMs).toBe(300_000);
    expect(loaded?.status).toBe("working");
    expect(loaded?.name).toBe("generate_report");
  });

  it("returns null for an unknown task", async () => {
    expect(await store.get("definitely-not-a-task")).toBeNull();
  });

  it("sets a TTL from ttlMs, and update does not extend it", async () => {
    const task = makeTask({ ttlMs: 60_000 });
    await store.create(task);

    const initial = await redis.pttl(prefix + task.taskId);
    expect(initial).toBeGreaterThan(0);
    expect(initial).toBeLessThanOrEqual(60_000);

    await store.update(task.taskId, { statusMessage: "Step 1/4" });
    const afterUpdate = await redis.pttl(prefix + task.taskId);
    // Still counting down from creation rather than reset — a chatty handler must not be able to
    // keep a task alive past its retention window.
    expect(afterUpdate).toBeLessThanOrEqual(initial);
    expect(afterUpdate).toBeGreaterThan(0);
  });

  it("stores no TTL when ttlMs is null", async () => {
    const task = makeTask({ ttlMs: null });
    await store.create(task);
    expect(await redis.pttl(prefix + task.taskId)).toBe(-1);
    expect((await store.get(task.taskId))?.ttlMs).toBeNull();
  });

  it("patches only the fields it is given", async () => {
    const task = makeTask();
    await store.create(task);

    const updated = await store.update(task.taskId, { statusMessage: "Step 2/4" });
    expect(updated.statusMessage).toBe("Step 2/4");
    expect(updated.status).toBe("working");
    expect(updated.args).toEqual({ topic: "coffee trends" });
    expect(updated.lastUpdatedAt >= task.lastUpdatedAt).toBe(true);
  });

  it("throws UnknownTaskError when updating a task that is gone", async () => {
    await expect(store.update("missing-task", { statusMessage: "x" })).rejects.toBeInstanceOf(
      UnknownTaskError,
    );
  });

  it("settles a working task and refuses every settle after it", async () => {
    const task = makeTask();
    await store.create(task);

    const completed = await store.settle(task.taskId, {
      status: "completed",
      statusMessage: "Completed",
      result: { content: [{ type: "text", text: "done" }] },
    });
    expect(completed?.settled).toBe(true);
    expect(completed?.task.status).toBe("completed");
    expect(completed?.task.result).toEqual({ content: [{ type: "text", text: "done" }] });

    // First terminal write wins: a later cancel cannot reopen or overwrite it, and gets the
    // current record back in the same round trip.
    const cancelled = await store.settle(task.taskId, { status: "cancelled" });
    expect(cancelled?.settled).toBe(false);
    expect(cancelled?.task.status).toBe("completed");
    expect((await store.get(task.taskId))?.status).toBe("completed");
  });

  it("loses the completion race to a cancel that got there first", async () => {
    const task = makeTask();
    await store.create(task);

    expect((await store.settle(task.taskId, { status: "cancelled" }))?.task.status).toBe(
      "cancelled",
    );
    // This is the executor finishing just after the client cancelled.
    expect((await store.settle(task.taskId, { status: "completed", result: {} }))?.settled).toBe(
      false,
    );
    expect((await store.get(task.taskId))?.status).toBe("cancelled");
  });

  it("returns null when settling a task that does not exist", async () => {
    expect(await store.settle("missing-task", { status: "completed" })).toBeNull();
  });

  it("ignores an update to a task that already finished", async () => {
    const task = makeTask();
    await store.create(task);
    await store.settle(task.taskId, { status: "cancelled", statusMessage: "Cancelled by client" });

    // A progress write landing after the cancel — or a handler that carried on and then errored.
    const after = await store.update(task.taskId, { statusMessage: "Attempt failed: too late" });

    expect(after.status).toBe("cancelled");
    expect(after.statusMessage).toBe("Cancelled by client");
  });

  it("creates only if absent, and hands back the existing task otherwise", async () => {
    const task = makeTask({ statusMessage: "first" });
    expect(await store.create(task)).toBeNull();

    const again = await store.create({ ...task, statusMessage: "second" });
    expect(again?.taskId).toBe(task.taskId);
    expect(again?.statusMessage).toBe("first");
    expect((await store.get(task.taskId))?.statusMessage).toBe("first");
  });

  it("returns the record from update and settle in the same round trip", async () => {
    const task = makeTask();
    await store.create(task);
    const updated = await store.update(task.taskId, { statusMessage: "42" });
    expect(updated.statusMessage).toBe("42");
    expect(updated.args).toEqual(task.args);

    const settled = await store.settle(task.taskId, {
      status: "completed",
      result: { content: [{ type: "text", text: "ok" }] },
    });
    expect(settled?.task.status).toBe("completed");
    expect(settled?.task.result).toEqual({ content: [{ type: "text", text: "ok" }] });
    // A finished task's update returns it unchanged rather than failing.
    expect((await store.update(task.taskId, { statusMessage: "late" })).statusMessage).toBe("42");
  });

  it("never creates a task as a side effect of updating a missing one", async () => {
    await expect(store.update("ghost", { statusMessage: "x" })).rejects.toBeInstanceOf(
      UnknownTaskError,
    );
    expect(await redis.exists(prefix + "ghost")).toBe(0);
  });
});

describe("constructing without credentials", () => {
  // A store and a dispatcher are normally created at module scope, and a Next.js production build
  // imports every route module to collect page data — with no environment loaded. Throwing in the
  // constructor fails the build of an app that would run fine in production, so the clients are
  // resolved on first use instead.
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.QSTASH_TOKEN;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("builds a RedisTaskStore with no env set", () => {
    expect(() => new RedisTaskStore()).not.toThrow();
  });

  it("builds a QStashDispatcher with no env set", () => {
    expect(() => new QStashDispatcher({ url: "https://example.com/api/execute" })).not.toThrow();
  });

  it("still reports the missing credentials when the client is actually used", async () => {
    await expect(new RedisTaskStore().get("t")).rejects.toThrow(/UPSTASH_REDIS_REST_URL/);
    await expect(
      new QStashDispatcher({ url: "https://example.com/api/execute" }).dispatch(makeTask()),
    ).rejects.toThrow(/QSTASH_TOKEN/);
  });
});

describe("QStashDispatcher.createExecuteHandler", () => {
  /** A Receiver stand-in: the real one needs live signing keys, and we are testing our own gate. */
  const receiver = (accept: boolean) =>
    ({
      verify: async () => {
        if (!accept) throw new Error("bad signature");
        return true;
      },
    }) as unknown as ConstructorParameters<typeof QStashDispatcher>[0]["receiver"];

  type Calls = { ran: string[]; failed: { taskId: string; error: TaskError }[] };

  /** Builds an attached dispatcher plus a record of what it called back into. */
  const attached = (options: { accept?: boolean; throws?: boolean } = {}) => {
    const { accept = true, throws = false } = options;
    const calls: Calls = { ran: [], failed: [] };
    const dispatcher = new QStashDispatcher({
      url: "https://example.com/api/execute",
      receiver: receiver(accept),
    });
    dispatcher.attach({
      run: async (taskId: string) => {
        calls.ran.push(taskId);
        if (throws) throw new Error("boom");
      },
      fail: async (taskId: string, error: TaskError) => {
        calls.failed.push({ taskId, error });
      },
    });
    return { handler: dispatcher.createExecuteHandler(), calls };
  };

  const deliver = (body: unknown) =>
    new Request("https://internal.example/api/execute", {
      method: "POST",
      headers: { "upstash-signature": "sig" },
      body: JSON.stringify(body),
    });

  /** QStash sends the original message body base64-encoded on the failure callback. */
  const base64 = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

  it("throws, rather than answering 401, when no signing keys are configured", async () => {
    const saved = { ...process.env };
    delete process.env.QSTASH_CURRENT_SIGNING_KEY;
    delete process.env.QSTASH_NEXT_SIGNING_KEY;
    try {
      const dispatcher = new QStashDispatcher({ url: "https://example.com/api/execute" });
      dispatcher.attach({ run: async () => undefined, fail: async () => undefined });
      await expect(dispatcher.createExecuteHandler()(deliver({ taskId: "t" }))).rejects.toThrow(
        /signing keys/,
      );
    } finally {
      process.env = saved;
    }
  });

  it("runs a delivery and acknowledges with 200", async () => {
    const { handler, calls } = attached();
    const response = await handler(deliver({ taskId: "t1" }));

    expect(response.status).toBe(200);
    expect(calls.ran).toEqual(["t1"]);
    expect(calls.failed).toEqual([]);
  });

  it("answers 500 so QStash retries, without failing the task", async () => {
    const { handler, calls } = attached({ throws: true });
    const response = await handler(deliver({ taskId: "t1" }));

    expect(response.status).toBe(500);
    // The transport has attempts left; nothing here decides the task has failed.
    expect(calls.failed).toEqual([]);
  });

  it("settles the task failed when the failure callback arrives", async () => {
    const { handler, calls } = attached();
    // The shape QStash posts once every retry is exhausted.
    const response = await handler(
      deliver({
        sourceBody: base64({ taskId: "t1" }),
        sourceMessageId: "msg_1",
        status: 500,
        body: Buffer.from("upstream exploded", "utf8").toString("base64"),
        retried: 5,
        maxRetries: 5,
        dlqId: "1788-0",
      }),
    );

    expect(response.status).toBe(200);
    // Never re-run on a failure callback — the work is over.
    expect(calls.ran).toEqual([]);
    expect(calls.failed).toHaveLength(1);
    expect(calls.failed[0]?.taskId).toBe("t1");
    expect(calls.failed[0]?.error.code).toBe(-32603);
    expect(calls.failed[0]?.error.message).toMatch(/5 retries.*status 500/);
    // Enough for an operator to find the message and see what the endpoint said.
    expect(calls.failed[0]?.error.data).toMatchObject({
      dlqId: "1788-0",
      status: 500,
      response: "upstream exploded",
    });
  });

  it("rejects an unsigned delivery as non-retryable and never runs the task", async () => {
    const { handler, calls } = attached({ accept: false });
    const response = await handler(deliver({ taskId: "t1" }));

    // QStash retries every non-2xx except this one, and a retry cannot fix a bad signature.
    expect(response.status).toBe(489);
    expect(response.headers.get("Upstash-NonRetryable-Error")).toBe("true");
    expect(calls.ran).toEqual([]);
    expect(calls.failed).toEqual([]);
  });

  it("rejects a body that is neither a delivery nor a failure callback", async () => {
    const { handler } = attached();
    expect((await handler(deliver({}))).status).toBe(489);
    expect(
      (
        await handler(
          new Request("https://internal.example/api/execute", {
            method: "POST",
            headers: { "upstash-signature": "sig" },
            body: "not json",
          }),
        )
      ).status,
    ).toBe(489);
  });

  it("decodes a non-ASCII failure response as UTF-8", async () => {
    const { handler, calls } = attached();
    await handler(
      deliver({
        sourceBody: base64({ taskId: "t1" }),
        status: 502,
        body: Buffer.from("Ağ geçidi hatası ✗", "utf8").toString("base64"),
      }),
    );
    expect(calls.failed[0]?.error.data).toMatchObject({ response: "Ağ geçidi hatası ✗" });
  });

  it("verifies against the published URL, not the incoming one", async () => {
    // Behind a proxy the incoming URL is internal, while QStash signed the public destination.
    const urls: string[] = [];
    const spy = {
      verify: async ({ url }: { url: string }) => {
        urls.push(url);
        return true;
      },
    } as unknown as ConstructorParameters<typeof QStashDispatcher>[0]["receiver"];

    const dispatcher = new QStashDispatcher({
      url: "https://public.example.com/api/execute",
      receiver: spy,
    });
    dispatcher.attach({ run: async () => undefined, fail: async () => undefined });

    await dispatcher.createExecuteHandler()(deliver({ taskId: "t1" }));
    expect(urls).toEqual(["https://public.example.com/api/execute"]);
  });

  it("refuses to serve before it is attached to a layer", async () => {
    const dispatcher = new QStashDispatcher({
      url: "https://example.com/api/execute",
      receiver: receiver(true),
    });
    await expect(dispatcher.createExecuteHandler()(deliver({ taskId: "t1" }))).rejects.toThrow(
      /not attached/,
    );
  });
});

describe("QStashDispatcher.dispatch", () => {
  it("deduplicates per task record, not per task id", async () => {
    const published: Record<string, unknown>[] = [];
    const qstash = {
      publishJSON: async (options: Record<string, unknown>) => {
        published.push(options);
        return { messageId: "msg_1" };
      },
    } as unknown as ConstructorParameters<typeof QStashDispatcher>[0]["qstash"];
    const dispatcher = new QStashDispatcher({ url: "https://example.com/api/execute", qstash });

    expect(await dispatcher.dispatch(makeTask({ taskId: "t" }))).toBe("msg_1");
    // Deduplicated on the task id, so a double dispatch of one task is delivered once.
    expect(published[0]?.deduplicationId).toBe("t");
    expect(published[0]?.body).toEqual({ taskId: "t" });
  });
});
