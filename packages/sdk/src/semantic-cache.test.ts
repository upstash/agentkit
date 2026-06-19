import { describe, expect, it } from "vitest";
import { SemanticCache } from "./semantic-cache.js";
import { MockModel } from "./testing/mock-model.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!hasRedisCreds)("SemanticCache (live Redis)", () => {
  const redis = testRedis();

  it("misses on an empty cache", async () => {
    const namespace = uniqueNamespace("semcache-empty");
    const cache = new SemanticCache({ redis, namespace, minScore: 0.5 });
    try {
      expect(await cache.get("anything at all")).toBeNull();
    } finally {
      await cache.searchIndex.drop().catch(() => {});
      await cleanupKeys(redis, namespace);
    }
  });

  it("returns a hit for a fuzzily similar prompt", async () => {
    const namespace = uniqueNamespace("semcache-hit");
    const cache = new SemanticCache({ redis, namespace, minScore: 0.5 });
    try {
      await cache.set("What is the capital of France?", "Paris");
      await cache.searchIndex.waitIndexing();

      const hit = await cache.get("capital of France");
      expect(hit?.response).toBe("Paris");
      expect(hit?.score).toBeGreaterThanOrEqual(0.5);
    } finally {
      await cache.searchIndex.drop().catch(() => {});
      await cleanupKeys(redis, namespace);
    }
  });

  it("misses for an unrelated prompt", async () => {
    const namespace = uniqueNamespace("semcache-miss");
    const cache = new SemanticCache({ redis, namespace, minScore: 0.5 });
    try {
      await cache.set("How do I bake sourdough bread?", "Mix flour and water");
      await cache.searchIndex.waitIndexing();
      expect(await cache.get("quantum chromodynamics lecture")).toBeNull();
    } finally {
      await cache.searchIndex.drop().catch(() => {});
      await cleanupKeys(redis, namespace);
    }
  });

  it("wrap() avoids calling the model on a cache hit", async () => {
    const namespace = uniqueNamespace("semcache-wrap");
    const cache = new SemanticCache({ redis, namespace, minScore: 0.5 });
    const model = new MockModel({ fallback: () => "Paris" });
    try {
      const first = await cache.wrap(model.generate)("What is the capital of France?");
      await cache.searchIndex.waitIndexing();
      const second = await cache.wrap(model.generate)("capital of France please");

      expect(first).toBe("Paris");
      expect(second).toBe("Paris");
      expect(model.callCount).toBe(1);
    } finally {
      await cache.searchIndex.drop().catch(() => {});
      await cleanupKeys(redis, namespace);
    }
  });

  it("evicts entries after their TTL elapses", async () => {
    const namespace = uniqueNamespace("semcache-ttl");
    const cache = new SemanticCache({ redis, namespace, minScore: 0.5, ttlSeconds: 1 });
    try {
      await cache.set("hello world greeting", "hi");
      await cache.searchIndex.waitIndexing();
      expect(await cache.get("hello world greeting")).not.toBeNull();

      await sleep(1300);
      expect(await cache.get("hello world greeting")).toBeNull();
    } finally {
      await cache.searchIndex.drop().catch(() => {});
      await cleanupKeys(redis, namespace);
    }
  });
});
