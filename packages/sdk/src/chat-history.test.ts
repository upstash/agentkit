import { beforeEach, describe, expect, it } from "vitest";
import { ChatHistory } from "./chat-history.js";
import { MemoryRedis } from "./testing/memory-redis.js";

describe("ChatHistory", () => {
  let redis: MemoryRedis;

  beforeEach(() => {
    redis = new MemoryRedis();
  });

  it("appends and lists messages oldest-first", async () => {
    const history = new ChatHistory({ redis });
    await history.append("s1", { role: "user", content: "hello" });
    await history.append("s1", { role: "assistant", content: "hi there" });

    const messages = await history.list("s1");
    expect(messages.map((m) => m.content)).toEqual(["hello", "hi there"]);
    expect(messages[0]!.createdAt).toBeTypeOf("number");
  });

  it("accepts a batch of messages", async () => {
    const history = new ChatHistory({ redis });
    await history.append("s1", [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
    expect(await history.count("s1")).toBe(2);
  });

  it("trims to maxMessages", async () => {
    const history = new ChatHistory({ redis, maxMessages: 2 });
    for (const c of ["1", "2", "3", "4"]) {
      await history.append("s1", { role: "user", content: c });
    }
    const messages = await history.list("s1");
    expect(messages.map((m) => m.content)).toEqual(["3", "4"]);
  });

  it("returns only the most recent N with limit", async () => {
    const history = new ChatHistory({ redis });
    for (const c of ["1", "2", "3"]) {
      await history.append("s1", { role: "user", content: c });
    }
    const recent = await history.list("s1", { limit: 2 });
    expect(recent.map((m) => m.content)).toEqual(["2", "3"]);
  });

  it("isolates sessions and clears", async () => {
    const history = new ChatHistory({ redis });
    await history.append("s1", { role: "user", content: "x" });
    await history.append("s2", { role: "user", content: "y" });
    await history.clear("s1");
    expect(await history.count("s1")).toBe(0);
    expect(await history.count("s2")).toBe(1);
  });

  it("applies a sliding TTL when configured", async () => {
    let t = 0;
    const clocked = new MemoryRedis({ clock: () => t });
    const history = new ChatHistory({ redis: clocked, ttlSeconds: 10 });
    await history.append("s1", { role: "user", content: "x" });
    t = 5_000;
    expect(await history.count("s1")).toBe(1);
    t = 11_000;
    expect(await history.count("s1")).toBe(0);
  });
});
