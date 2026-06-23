import { afterAll, describe, expect, it, vi } from "vitest";
import { ToolCache } from "./tool-cache.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!hasRedisCreds)("ToolCache (live Redis)", () => {
  const redis = testRedis();
  const namespace = uniqueNamespace("tool");

  afterAll(async () => {
    await cleanupKeys(redis, namespace);
  });

  it("misses then hits", async () => {
    const cache = new ToolCache({ redis, namespace });
    expect(await cache.get("weather", { city: "NYC" })).toBeNull();
    await cache.set("weather", { city: "NYC" }, { temp: 20 });
    expect(await cache.get<{ temp: number }>("weather", { city: "NYC" })).toEqual({
      value: { temp: 20 },
    });
  });

  it("keys are order-insensitive over argument objects", async () => {
    const cache = new ToolCache({ redis, namespace });
    await cache.set("order", { a: 1, b: 2 }, "result");
    expect(await cache.get("order", { b: 2, a: 1 })).toEqual({ value: "result" });
  });

  it("distinguishes a cached null from a miss", async () => {
    const cache = new ToolCache({ redis, namespace });
    await cache.set("nullable", { x: 1 }, null);
    expect(await cache.get("nullable", { x: 1 })).toEqual({ value: null });
    expect(await cache.get("nullable", { x: 2 })).toBeNull();
  });

  it("wrap() memoizes and only executes once", async () => {
    const cache = new ToolCache({ redis, namespace });
    const execute = vi.fn(async (args: { n: number }) => args.n * 2);
    const wrapped = cache.wrap("double", execute);

    expect(await wrapped({ n: 21 })).toBe(42);
    expect(await wrapped({ n: 21 })).toBe(42);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("invalidate removes an entry", async () => {
    const cache = new ToolCache({ redis, namespace });
    await cache.set("inv", { x: 1 }, "v");
    await cache.invalidate("inv", { x: 1 });
    expect(await cache.get("inv", { x: 1 })).toBeNull();
  });

  // The per-call namespace is the cache-key prefix — an empty/missing one must throw, so unrelated
  // tools (or per-user keys) can't collapse into one shared cache entry.
  it("requires a non-empty per-call namespace", async () => {
    const cache = new ToolCache({ redis, namespace });
    await expect(cache.get("", { x: 1 })).rejects.toThrow(/namespace/i);
    await expect(cache.get(undefined as unknown as string, { x: 1 })).rejects.toThrow(/namespace/i);
    await expect(cache.set("", { x: 1 }, "v")).rejects.toThrow(/namespace/i);
    await expect(cache.invalidate("", { x: 1 })).rejects.toThrow(/namespace/i);
    await expect(cache.wrap("", async () => 1)({})).rejects.toThrow(/namespace/i);
  });

  it("honors TTL", async () => {
    const cache = new ToolCache({ redis, namespace, ttlSeconds: 1 });
    await cache.set("ttl", { x: 1 }, "v");
    expect(await cache.get("ttl", { x: 1 })).toEqual({ value: "v" });
    await sleep(1300);
    expect(await cache.get("ttl", { x: 1 })).toBeNull();
  });
});
