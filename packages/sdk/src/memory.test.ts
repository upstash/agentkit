import { beforeEach, describe, expect, it } from "vitest";
import { AgentMemory } from "./memory.js";
import { MemoryRedis } from "./testing/memory-redis.js";
import { MemoryVectorStore } from "./testing/memory-vector-store.js";
import { MockEmbedder } from "./testing/mock-embedder.js";

describe("AgentMemory", () => {
  let vector: MemoryVectorStore;
  let embedder: MockEmbedder;
  let redis: MemoryRedis;

  beforeEach(() => {
    embedder = new MockEmbedder();
    vector = new MemoryVectorStore();
    redis = new MemoryRedis();
  });

  it("stores and semantically recalls memories", async () => {
    const memory = new AgentMemory({ vector, embedder });
    await memory.add("The user loves hiking in the mountains");
    await memory.add("The user is allergic to peanuts");

    const recalled = await memory.recall("outdoor activities the user enjoys", { topK: 1 });
    expect(recalled).toHaveLength(1);
    expect(recalled[0]!.text).toContain("hiking");
    expect(recalled[0]!.score).toBeGreaterThan(0);
  });

  it("isolates memories by scope", async () => {
    const memory = new AgentMemory({ vector, embedder });
    await memory.add("alice likes tea", { scope: "alice" });
    await memory.add("bob likes coffee", { scope: "bob" });

    const aliceHits = await memory.recall("beverage preference", { scope: "alice", topK: 5 });
    expect(aliceHits.every((h) => h.text.includes("alice"))).toBe(true);
  });

  it("respects minScore", async () => {
    const memory = new AgentMemory({ vector, embedder, minScore: 0.99 });
    await memory.add("completely unrelated content about databases");
    const hits = await memory.recall("a totally different topic like cooking", { topK: 5 });
    expect(hits).toHaveLength(0);
  });

  it("forgets a memory and keeps the registry in sync", async () => {
    const memory = new AgentMemory({ vector, embedder, redis });
    const rec = await memory.add("ephemeral fact", { scope: "u1" });
    expect(await memory.listIds("u1")).toContain(rec.id);

    await memory.forget(rec.id, { scope: "u1" });
    expect(await memory.listIds("u1")).not.toContain(rec.id);
    const hits = await memory.recall("ephemeral fact", { scope: "u1", topK: 5 });
    expect(hits).toHaveLength(0);
  });

  it("throws on listIds without a redis client", async () => {
    const memory = new AgentMemory({ vector, embedder });
    await expect(memory.listIds()).rejects.toThrow(/requires a `redis`/);
  });

  it("preserves custom metadata round-trip", async () => {
    const memory = new AgentMemory({ vector, embedder });
    await memory.add("fact with metadata", { metadata: { source: "manual" } });
    const [hit] = await memory.recall("fact with metadata", { topK: 1 });
    expect(hit!.metadata).toEqual({ source: "manual" });
  });
});
