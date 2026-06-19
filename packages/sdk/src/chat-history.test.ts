import { afterAll, describe, expect, it } from "vitest";
import { ChatHistory } from "./chat-history.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!hasRedisCreds)("ChatHistory (live Redis)", () => {
  const redis = testRedis();
  const namespace = uniqueNamespace("chat");

  afterAll(async () => {
    await cleanupKeys(redis, namespace);
  });

  it("appends and lists messages oldest-first", async () => {
    const history = new ChatHistory({ redis, namespace });
    await history.append("s1", { role: "user", content: "hello" });
    await history.append("s1", { role: "assistant", content: "hi there" });

    const messages = await history.list("s1");
    expect(messages.map((m) => m.content)).toEqual(["hello", "hi there"]);
    expect(messages[0]!.createdAt).toBeTypeOf("number");
  });

  it("accepts a batch of messages", async () => {
    const history = new ChatHistory({ redis, namespace });
    await history.append("batch", [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
    expect(await history.count("batch")).toBe(2);
  });

  it("trims to maxMessages", async () => {
    const history = new ChatHistory({ redis, namespace, maxMessages: 2 });
    for (const c of ["1", "2", "3", "4"]) {
      await history.append("trim", { role: "user", content: c });
    }
    const messages = await history.list("trim");
    expect(messages.map((m) => m.content)).toEqual(["3", "4"]);
  });

  it("returns only the most recent N with limit", async () => {
    const history = new ChatHistory({ redis, namespace });
    for (const c of ["1", "2", "3"]) {
      await history.append("limit", { role: "user", content: c });
    }
    const recent = await history.list("limit", { limit: 2 });
    expect(recent.map((m) => m.content)).toEqual(["2", "3"]);
  });

  it("isolates sessions and clears", async () => {
    const history = new ChatHistory({ redis, namespace });
    await history.append("clearA", { role: "user", content: "x" });
    await history.append("clearB", { role: "user", content: "y" });
    await history.clear("clearA");
    expect(await history.count("clearA")).toBe(0);
    expect(await history.count("clearB")).toBe(1);
  });

  it("applies a sliding TTL when configured", async () => {
    const history = new ChatHistory({ redis, namespace, ttlSeconds: 1 });
    await history.append("ttl", { role: "user", content: "x" });
    expect(await history.count("ttl")).toBe(1);
    await sleep(1300);
    expect(await history.count("ttl")).toBe(0);
  });
});
