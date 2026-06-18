import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolCache } from "./tool-cache.js";
import { MemoryRedis } from "./testing/memory-redis.js";

describe("ToolCache", () => {
  let redis: MemoryRedis;

  beforeEach(() => {
    redis = new MemoryRedis();
  });

  it("misses then hits", async () => {
    const cache = new ToolCache({ redis });
    expect(await cache.get("weather", { city: "NYC" })).toBeNull();
    await cache.set("weather", { city: "NYC" }, { temp: 20 });
    expect(await cache.get<{ temp: number }>("weather", { city: "NYC" })).toEqual({
      value: { temp: 20 },
    });
  });

  it("keys are order-insensitive over argument objects", async () => {
    const cache = new ToolCache({ redis });
    await cache.set("t", { a: 1, b: 2 }, "result");
    const hit = await cache.get("t", { b: 2, a: 1 });
    expect(hit).toEqual({ value: "result" });
  });

  it("distinguishes a cached null from a miss", async () => {
    const cache = new ToolCache({ redis });
    await cache.set("t", { x: 1 }, null);
    expect(await cache.get("t", { x: 1 })).toEqual({ value: null });
    expect(await cache.get("t", { x: 2 })).toBeNull();
  });

  it("wrap() memoizes and only executes once", async () => {
    const cache = new ToolCache({ redis });
    const execute = vi.fn(async (args: { n: number }) => args.n * 2);
    const wrapped = cache.wrap("double", execute);

    expect(await wrapped({ n: 21 })).toBe(42);
    expect(await wrapped({ n: 21 })).toBe(42);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("invalidate removes an entry", async () => {
    const cache = new ToolCache({ redis });
    await cache.set("t", { x: 1 }, "v");
    await cache.invalidate("t", { x: 1 });
    expect(await cache.get("t", { x: 1 })).toBeNull();
  });

  it("honors TTL", async () => {
    let t = 0;
    const clocked = new MemoryRedis({ clock: () => t });
    const cache = new ToolCache({ redis: clocked, ttlSeconds: 10 });
    await cache.set("t", { x: 1 }, "v");
    t = 11_000;
    expect(await cache.get("t", { x: 1 })).toBeNull();
  });
});
