import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { QStashDispatcher, RedisTaskStore, isFinalQStashAttempt } from "./upstash.js";
import { UnknownTaskError, type Task } from "./types.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniquePrefix } from "./test-support.js";

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
    expect(completed?.status).toBe("completed");
    expect(completed?.result).toEqual({ content: [{ type: "text", text: "done" }] });

    // First terminal write wins: a later cancel cannot reopen or overwrite it.
    const cancelled = await store.settle(task.taskId, { status: "cancelled" });
    expect(cancelled).toBeNull();
    expect((await store.get(task.taskId))?.status).toBe("completed");
  });

  it("loses the completion race to a cancel that got there first", async () => {
    const task = makeTask();
    await store.create(task);

    expect((await store.settle(task.taskId, { status: "cancelled" }))?.status).toBe("cancelled");
    // This is the executor finishing just after the client cancelled.
    expect(await store.settle(task.taskId, { status: "completed", result: {} })).toBeNull();
    expect((await store.get(task.taskId))?.status).toBe("cancelled");
  });

  it("returns null when settling a task that does not exist", async () => {
    expect(await store.settle("missing-task", { status: "completed" })).toBeNull();
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
      new QStashDispatcher({ url: "https://example.com/api/execute" }).dispatch("t"),
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

  const dispatcher = (accept = true, retries = 3) =>
    new QStashDispatcher({
      url: "https://example.com/api/execute",
      retries,
      receiver: receiver(accept),
    });

  const deliver = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("https://internal.example/api/execute", {
      method: "POST",
      headers: { "upstash-signature": "sig", ...headers },
      body: JSON.stringify(body),
    });

  it("runs the task and acknowledges with 200", async () => {
    const ran: { taskId: string; isFinalAttempt: boolean }[] = [];
    const handler = dispatcher().createExecuteHandler(async (taskId, options) => {
      ran.push({ taskId, ...options });
    });

    const response = await handler(deliver({ taskId: "t1" }, { "upstash-retried": "0" }));
    expect(response.status).toBe(200);
    expect(ran).toEqual([{ taskId: "t1", isFinalAttempt: false }]);
  });

  it("tells the runner when QStash is out of retries", async () => {
    const seen: boolean[] = [];
    const handler = dispatcher(true, 3).createExecuteHandler(
      async (_taskId, { isFinalAttempt }) => {
        seen.push(isFinalAttempt);
      },
    );

    await handler(deliver({ taskId: "t1" }, { "upstash-retried": "2" }));
    await handler(deliver({ taskId: "t1" }, { "upstash-retried": "3" }));
    expect(seen).toEqual([false, true]);
  });

  it("answers 500 so QStash retries when the task throws", async () => {
    const handler = dispatcher().createExecuteHandler(async () => {
      throw new Error("boom");
    });
    const response = await handler(deliver({ taskId: "t1" }));
    expect(response.status).toBe(500);
  });

  it("rejects an unsigned delivery with 401 and never runs the task", async () => {
    let ran = false;
    const handler = dispatcher(false).createExecuteHandler(async () => {
      ran = true;
    });

    const response = await handler(deliver({ taskId: "t1" }));
    // 401 rather than 500 on purpose: a retry cannot fix a bad signature, and answering 500 would
    // make QStash replay an unauthenticated request.
    expect(response.status).toBe(401);
    expect(ran).toBe(false);
  });

  it("rejects a body with no task id, without asking for a retry", async () => {
    const handler = dispatcher().createExecuteHandler(async () => undefined);
    expect((await handler(deliver({}))).status).toBe(400);
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
    ).toBe(400);
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

    const handler = new QStashDispatcher({
      url: "https://public.example.com/api/execute",
      receiver: spy,
    }).createExecuteHandler(async () => undefined);

    await handler(deliver({ taskId: "t1" }));
    expect(urls).toEqual(["https://public.example.com/api/execute"]);
  });
});

describe("isFinalQStashAttempt", () => {
  it("is false while retries remain", () => {
    expect(isFinalQStashAttempt(new Headers({ "upstash-retried": "0" }), 3)).toBe(false);
    expect(isFinalQStashAttempt(new Headers({ "upstash-retried": "2" }), 3)).toBe(false);
  });

  it("is true on the last attempt", () => {
    expect(isFinalQStashAttempt(new Headers({ "upstash-retried": "3" }), 3)).toBe(true);
    expect(isFinalQStashAttempt(new Headers({ "upstash-retried": "9" }), 3)).toBe(true);
  });

  it("treats a non-QStash delivery as final, so a failure is still recorded", () => {
    expect(isFinalQStashAttempt(new Headers(), 3)).toBe(true);
  });

  it("reads a plain header record too", () => {
    expect(isFinalQStashAttempt({ "Upstash-Retried": "1" }, 5)).toBe(false);
    expect(isFinalQStashAttempt({ "Upstash-Retried": "5" }, 5)).toBe(true);
  });
});
