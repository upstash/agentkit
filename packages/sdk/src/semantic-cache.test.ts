import { beforeEach, describe, expect, it } from "vitest";
import { SemanticCache } from "./semantic-cache.js";
import { MemoryRedis } from "./testing/memory-redis.js";
import { MemorySearchStore } from "./testing/memory-search-store.js";
import { MockModel } from "./testing/mock-model.js";

describe("SemanticCache", () => {
  let search: MemorySearchStore;

  beforeEach(() => {
    search = new MemorySearchStore();
  });

  it("misses on an empty cache", async () => {
    const cache = new SemanticCache({ search });
    expect(await cache.get("anything")).toBeNull();
  });

  it("returns a hit for a fuzzily similar prompt", async () => {
    const cache = new SemanticCache({ search, minScore: 0.5 });
    await cache.set("What is the capital of France?", "Paris");

    const hit = await cache.get("capital of France");
    expect(hit).not.toBeNull();
    expect(hit!.response).toBe("Paris");
    expect(hit!.score).toBeGreaterThanOrEqual(0.5);
  });

  it("does not return a hit below the threshold", async () => {
    const cache = new SemanticCache({ search, minScore: 0.95 });
    await cache.set("How do I bake bread?", "Mix flour and water");
    expect(await cache.get("quantum chromodynamics explained")).toBeNull();
  });

  it("wrap() avoids calling the model on a cache hit", async () => {
    const cache = new SemanticCache({ search, minScore: 0.5 });
    const model = new MockModel({ fallback: () => "Paris" });
    const generate = cache.wrap(model.generate);

    const first = await generate("What is the capital of France?");
    const second = await generate("capital of France please");

    expect(first).toBe("Paris");
    expect(second).toBe("Paris");
    expect(model.callCount).toBe(1); // second was served from cache
  });

  it("evicts expired entries when TTL elapses", async () => {
    let t = 0;
    const redis = new MemoryRedis({ clock: () => t });
    const cache = new SemanticCache({ search, redis, ttlSeconds: 10, minScore: 0.5 });
    await cache.set("hello world", "hi");

    t = 5_000;
    expect(await cache.get("hello world")).not.toBeNull();
    t = 11_000;
    expect(await cache.get("hello world")).toBeNull();
  });
});
