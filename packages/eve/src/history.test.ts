import { ChatHistory } from "@upstash/agentkit-sdk";
import { afterAll, describe, expect, it } from "vitest";
import { createHistoryHooks } from "./history.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

describe.skipIf(!hasRedisCreds)("createHistoryHooks (live Redis)", () => {
  const redis = testRedis();
  const namespace = uniqueNamespace("eve-hist");
  const history = new ChatHistory({ redis, namespace });

  afterAll(async () => {
    await cleanupKeys(redis, namespace);
  });

  it("round-trips append -> load preserving order and roles", async () => {
    const hooks = createHistoryHooks({ history, sessionId: "s-1" });
    await hooks.append({ role: "user", content: "Hello" });
    await hooks.append({ role: "assistant", content: "Hi there" });

    const loaded = await hooks.load();
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toMatchObject({ role: "user", content: "Hello" });
    expect(loaded[1]).toMatchObject({ role: "assistant", content: "Hi there" });
  });

  it("appends an array of messages", async () => {
    const hooks = createHistoryHooks({ history, sessionId: "s-2" });
    await hooks.append([
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
    ]);
    expect((await hooks.load()).map((m) => m.content)).toEqual(["one", "two"]);
  });

  it("respects the load limit (most recent, oldest-first)", async () => {
    const hooks = createHistoryHooks({ history, sessionId: "s-3" });
    await hooks.append([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]);
    expect((await hooks.load({ limit: 2 })).map((m) => m.content)).toEqual(["b", "c"]);
  });

  it("normalizes unknown Eve roles to user", async () => {
    const hooks = createHistoryHooks({ history, sessionId: "s-4" });
    await hooks.append({ role: "weird-role", content: "x" });
    expect((await hooks.load())[0]!.role).toBe("user");
  });

  it("ignores empty append calls", async () => {
    const hooks = createHistoryHooks({ history, sessionId: "s-5" });
    await hooks.append([]);
    expect(await hooks.load()).toEqual([]);
  });
});
