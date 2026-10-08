import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { QStashDispatcher, RedisTaskStore } from "./qstash.js";
import type { Task, TaskError } from "../types.js";
import {
  cleanupKeys,
  hasRedisCreds,
  qstashRequest,
  testReceiver,
  testRedis,
  uniquePrefix,
} from "../../test-support.js";

const makeTask = (overrides: Partial<Task> = {}): Task => {
  const now = new Date().toISOString();
  return {
    taskId: crypto.randomUUID(),
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
    expect(loaded).toEqual(task);
    expect(typeof loaded?.statusMessage).toBe("string");
  });

  it("returns null for an unknown task", async () => {
    expect(await store.get(crypto.randomUUID())).toBeNull();
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

  it("patches only the fields it is given", async () => {
    const task = makeTask();
    await store.create(task);

    await store.update(task.taskId, { statusMessage: "Step 2/4" });
    const updated = await store.get(task.taskId);
    expect(updated?.statusMessage).toBe("Step 2/4");
    expect(updated?.status).toBe("working");
    expect(updated?.args).toEqual({ topic: "coffee trends" });
    expect(updated!.lastUpdatedAt >= task.lastUpdatedAt).toBe(true);
  });

  it("settles a working task and refuses every settle after it", async () => {
    const task = makeTask();
    await store.create(task);

    const completed = await store.settle(task.taskId, {
      status: "completed",
      statusMessage: "Completed",
      result: { content: [{ type: "text", text: "done" }] },
    });
    expect(completed?.status).toBe("completed");
    expect(completed?.result).toEqual({ content: [{ type: "text", text: "done" }] });

    // First terminal write wins: a later cancel cannot reopen or overwrite it, and gets the
    // current record back in the same round trip.
    const cancelled = await store.settle(task.taskId, { status: "cancelled" });
    expect(cancelled?.status).toBe("completed");
    expect((await store.get(task.taskId))?.status).toBe("completed");
  });

  it("loses the completion race to a cancel that got there first", async () => {
    const task = makeTask();
    await store.create(task);

    expect((await store.settle(task.taskId, { status: "cancelled" }))?.status).toBe("cancelled");
    // This is the executor finishing just after the client cancelled.
    expect((await store.settle(task.taskId, { status: "completed", result: {} }))?.status).toBe(
      "cancelled",
    );
  });

  it("returns null when settling a task that does not exist", async () => {
    expect(await store.settle(crypto.randomUUID(), { status: "completed" })).toBeNull();
  });

  it("ignores an update to a task that already finished", async () => {
    const task = makeTask();
    await store.create(task);
    await store.settle(task.taskId, { status: "cancelled", statusMessage: "Cancelled by client" });

    // A progress write landing after the cancel — or a handler that carried on and then errored.
    await store.update(task.taskId, { statusMessage: "Attempt failed: too late" });

    const after = await store.get(task.taskId);
    expect(after?.status).toBe("cancelled");
    expect(after?.statusMessage).toBe("Cancelled by client");
  });

  it("never creates a task as a side effect of updating a missing one", async () => {
    const ghost = crypto.randomUUID();
    await store.update(ghost, { statusMessage: "x" });
    expect(await redis.exists(prefix + ghost)).toBe(0);
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
  const URL = "https://public.example.com/api/execute";

  type Calls = { ran: string[]; failed: { taskId: string; error: TaskError }[] };

  /** A handler over a real Receiver, plus a record of what it called back into. */
  const connected = (options: { throws?: boolean } = {}) => {
    const calls: Calls = { ran: [], failed: [] };
    const dispatcher = new QStashDispatcher({ url: URL, receiver: testReceiver() });
    const handler = dispatcher.createExecuteHandler({
      run: async (taskId: string) => {
        calls.ran.push(taskId);
        if (options.throws) throw new Error("boom");
      },
      fail: async (taskId: string, error: TaskError) => {
        calls.failed.push({ taskId, error });
      },
    });
    return { handler, calls };
  };

  /** QStash sends the original message body base64-encoded on the failure callback. */
  const base64 = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

  it("throws, rather than answering 401, when no signing keys are configured", async () => {
    const saved = { ...process.env };
    delete process.env.QSTASH_CURRENT_SIGNING_KEY;
    delete process.env.QSTASH_NEXT_SIGNING_KEY;
    try {
      const handler = new QStashDispatcher({ url: URL }).createExecuteHandler({
        run: async () => undefined,
        fail: async () => undefined,
      });
      await expect(handler(qstashRequest(URL, { taskId: "t" }))).rejects.toThrow(/signing keys/);
    } finally {
      process.env = saved;
    }
  });

  it("runs a signed delivery and acknowledges with 200", async () => {
    const { handler, calls } = connected();
    const response = await handler(qstashRequest(URL, { taskId: "t1" }));

    expect(response.status).toBe(200);
    expect(calls.ran).toEqual(["t1"]);
    expect(calls.failed).toEqual([]);
  });

  it("verifies against the published URL, so it works behind a proxy", async () => {
    const { handler, calls } = connected();
    // The request arrives on an internal URL, but QStash signed the public destination.
    const signed = qstashRequest(URL, { taskId: "t1" });
    const proxied = new Request("http://10.0.0.5:3000/api/execute", {
      method: "POST",
      headers: signed.headers,
      body: await signed.text(),
    });
    expect((await handler(proxied)).status).toBe(200);
    expect(calls.ran).toEqual(["t1"]);
  });

  it("answers 500 so QStash retries, without failing the task", async () => {
    const { handler, calls } = connected({ throws: true });
    const response = await handler(qstashRequest(URL, { taskId: "t1" }));

    expect(response.status).toBe(500);
    // The transport has attempts left; nothing here decides the task has failed.
    expect(calls.failed).toEqual([]);
  });

  it("settles the task failed when the failure callback arrives", async () => {
    const { handler, calls } = connected();
    // The shape QStash posts once every retry is exhausted.
    const response = await handler(
      qstashRequest(URL, {
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

  describe("refuses, as non-retryable, and never runs or fails a task", () => {
    const cases: [string, Request][] = [
      [
        "an unsigned delivery",
        new Request(URL, { method: "POST", body: JSON.stringify({ taskId: "t1" }) }),
      ],
      ["a signature from another key", qstashRequest(URL, { taskId: "t1" }, { key: "stolen" })],
      [
        "a signature issued for another endpoint",
        qstashRequest(URL, { taskId: "t1" }, { sub: "https://public.example.com/api/other" }),
      ],
      [
        "a body the signature does not cover",
        qstashRequest(URL, { taskId: "t1" }, { body: "aGFzaCBvZiBzb21ldGhpbmcgZWxzZQ" }),
      ],
      [
        "an expired signature",
        qstashRequest(URL, { taskId: "t1" }, { exp: Math.floor(Date.now() / 1000) - 600 }),
      ],
    ];
    for (const [label, request] of cases) {
      it(label, async () => {
        const { handler, calls } = connected();
        const response = await handler(request.clone());
        // QStash retries every non-2xx except this one, and a retry cannot fix a bad signature.
        expect(response.status).toBe(489);
        expect(response.headers.get("Upstash-NonRetryable-Error")).toBe("true");
        expect(calls).toEqual({ ran: [], failed: [] });
      });
    }
  });

  it("rejects a signed body that is neither a delivery nor a failure callback", async () => {
    const { handler, calls } = connected();
    expect((await handler(qstashRequest(URL, {}))).status).toBe(489);
    expect((await handler(qstashRequest(URL, "not json"))).status).toBe(489);
    expect(calls).toEqual({ ran: [], failed: [] });
  });

  it("decodes a non-ASCII failure response as UTF-8", async () => {
    const { handler, calls } = connected();
    await handler(
      qstashRequest(URL, {
        sourceBody: base64({ taskId: "t1" }),
        status: 502,
        body: Buffer.from("Ağ geçidi hatası ✗", "utf8").toString("base64"),
      }),
    );
    expect(calls.failed[0]?.error.data).toMatchObject({ response: "Ağ geçidi hatası ✗" });
  });
});

describe("QStashDispatcher.dispatch", () => {
  it("publishes only the task id", async () => {
    const published: Record<string, unknown>[] = [];
    const qstash = {
      publishJSON: async (options: Record<string, unknown>) => {
        published.push(options);
        return { messageId: "msg_1" };
      },
    } as unknown as ConstructorParameters<typeof QStashDispatcher>[0]["qstash"];
    const dispatcher = new QStashDispatcher({ url: "https://example.com/api/execute", qstash });

    const task = makeTask();
    await dispatcher.dispatch(task);
    expect(published[0]).not.toHaveProperty("deduplicationId");
    expect(published[0]?.body).toEqual({ taskId: task.taskId });
    expect(published[0]?.failureCallback).toBe("https://example.com/api/execute");
  });
});
