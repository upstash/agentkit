import { afterAll, describe, expect, it, vi } from "vitest";
import { ToolCache } from "./tool-cache.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniquePrefix } from "./test-support.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const U = "user-1"; // a per-call userId — the cache key is `<prefix>:<userId>:<toolName>:<hash>`

describe.skipIf(!hasRedisCreds)("ToolCache (live Redis)", () => {
  const redis = testRedis();
  const prefix = uniquePrefix("tool");

  afterAll(async () => {
    await cleanupKeys(redis, prefix);
  });

  it("misses then hits", async () => {
    const cache = new ToolCache({ redis, prefix });
    expect(await cache.get(U, "weather", { city: "NYC" })).toBeNull();
    await cache.set(U, "weather", { city: "NYC" }, { temp: 20 });
    expect(await cache.get<{ temp: number }>(U, "weather", { city: "NYC" })).toEqual({
      value: { temp: 20 },
    });
  });

  it("isolates cache entries by userId", async () => {
    const cache = new ToolCache({ redis, prefix });
    await cache.set("alice", "weather", { city: "NYC" }, { temp: 1 });
    await cache.set("bob", "weather", { city: "NYC" }, { temp: 2 });
    expect(await cache.get("alice", "weather", { city: "NYC" })).toEqual({ value: { temp: 1 } });
    expect(await cache.get("bob", "weather", { city: "NYC" })).toEqual({ value: { temp: 2 } });
  });

  it("keys are order-insensitive over argument objects", async () => {
    const cache = new ToolCache({ redis, prefix });
    await cache.set(U, "order", { a: 1, b: 2 }, "result");
    expect(await cache.get(U, "order", { b: 2, a: 1 })).toEqual({ value: "result" });
  });

  it("distinguishes a cached null from a miss", async () => {
    const cache = new ToolCache({ redis, prefix });
    await cache.set(U, "nullable", { x: 1 }, null);
    expect(await cache.get(U, "nullable", { x: 1 })).toEqual({ value: null });
    expect(await cache.get(U, "nullable", { x: 2 })).toBeNull();
  });

  it("wrap() memoizes and only executes once", async () => {
    const cache = new ToolCache({ redis, prefix });
    const execute = vi.fn(async (args: { n: number }) => args.n * 2);
    const wrapped = cache.wrap(U, "double", execute);

    expect(await wrapped({ n: 21 })).toBe(42);
    expect(await wrapped({ n: 21 })).toBe(42);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("invalidate removes an entry", async () => {
    const cache = new ToolCache({ redis, prefix });
    await cache.set(U, "inv", { x: 1 }, "v");
    await cache.invalidate(U, "inv", { x: 1 });
    expect(await cache.get(U, "inv", { x: 1 })).toBeNull();
  });

  // userId and toolName are both part of the cache key — an empty/missing one must throw, so unrelated
  // users (or tools) can't collapse into one shared cache entry.
  it("requires a non-empty userId and toolName", async () => {
    const cache = new ToolCache({ redis, prefix });
    await expect(cache.get("", "tool", { x: 1 })).rejects.toThrow(/userId/i);
    await expect(cache.get(U, "", { x: 1 })).rejects.toThrow(/toolName/i);
    await expect(cache.set("", "tool", { x: 1 }, "v")).rejects.toThrow(/userId/i);
    await expect(cache.invalidate(U, "", { x: 1 })).rejects.toThrow(/toolName/i);
    await expect(cache.wrap("", "tool", async () => 1)({})).rejects.toThrow(/userId/i);
  });

  it("honors TTL", async () => {
    const cache = new ToolCache({ redis, prefix, ttlSeconds: 1 });
    await cache.set(U, "ttl", { x: 1 }, "v");
    expect(await cache.get(U, "ttl", { x: 1 })).toEqual({ value: "v" });
    await sleep(1300);
    expect(await cache.get(U, "ttl", { x: 1 })).toBeNull();
  });
});
