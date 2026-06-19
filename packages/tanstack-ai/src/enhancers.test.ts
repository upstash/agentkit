import { AgentMemory, SemanticCache } from "@upstash/agentkit-sdk";
import { MockModel } from "@upstash/agentkit-sdk/testing";
import { afterAll, describe, expect, it } from "vitest";
import { withMemory, withSemanticCache } from "./enhancers.js";
import { hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

describe.skipIf(!hasRedisCreds)("withSemanticCache", () => {
  const redis = testRedis();
  const caches: SemanticCache[] = [];

  afterAll(async () => {
    for (const cache of caches) await cache.searchIndex.drop().catch(() => {});
  });

  it("serves a similar prompt from cache without calling the model", async () => {
    const cache = new SemanticCache({
      redis,
      namespace: uniqueNamespace("semcache"),
      minScore: 0.5,
    });
    caches.push(cache);
    const model = new MockModel({ responses: ["Paris"] });

    const cached = withSemanticCache(model.generate, { cache });

    const first = await cached("What is the capital of France?");
    await cache.searchIndex.waitIndexing();
    const second = await cached("What's the capital of France?");

    expect(first).toBe("Paris");
    expect(second).toBe("Paris");
    expect(model.callCount).toBe(1);
  });
});

describe.skipIf(!hasRedisCreds)("withMemory", () => {
  const redis = testRedis();
  const memories: AgentMemory[] = [];

  afterAll(async () => {
    for (const memory of memories) await memory.searchIndex.drop().catch(() => {});
  });

  it("recalls memories and formats them as a context message", async () => {
    const memory = new AgentMemory({ redis, namespace: uniqueNamespace("memory") });
    memories.push(memory);

    await memory.add("The user prefers dark mode", { scope: "u1" });
    await memory.searchIndex.waitIndexing();

    const injector = withMemory({ memory, scope: "u1", minScore: 0.1 });
    const context = await injector.recall("what mode does the user prefer");

    expect(context).not.toBeNull();
    expect(context?.role).toBe("system");
    expect(context?.content).toContain("dark mode");
  });

  it("returns null when nothing relevant is recalled", async () => {
    const memory = new AgentMemory({ redis, namespace: uniqueNamespace("memory") });
    memories.push(memory);

    await memory.add("The user prefers dark mode", { scope: "u1" });
    await memory.searchIndex.waitIndexing();

    const injector = withMemory({ memory, scope: "u1", minScore: 0.99 });
    const context = await injector.recall("quantum chromodynamics explained");

    expect(context).toBeNull();
  });
});
