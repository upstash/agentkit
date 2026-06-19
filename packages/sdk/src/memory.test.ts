import { beforeEach, describe, expect, it } from "vitest";
import { AgentMemory } from "./memory.js";
import { MemoryRedis } from "./testing/memory-redis.js";
import { MemorySearchStore } from "./testing/memory-search-store.js";

describe("AgentMemory", () => {
  let search: MemorySearchStore;
  let redis: MemoryRedis;

  beforeEach(() => {
    search = new MemorySearchStore();
    redis = new MemoryRedis();
  });

  it("stores and fuzzily recalls memories", async () => {
    const memory = new AgentMemory({ search });
    await memory.add("The user loves hiking in the mountains");
    await memory.add("The user is allergic to peanuts");

    const recalled = await memory.recall("hiking mountains", { topK: 1 });
    expect(recalled).toHaveLength(1);
    expect(recalled[0]!.text).toContain("hiking");
    expect(recalled[0]!.score).toBeGreaterThan(0);
  });

  it("tolerates typos via fuzzy matching", async () => {
    const memory = new AgentMemory({ search });
    await memory.add("The user prefers TypeScript");
    const recalled = await memory.recall("typescrpt", { topK: 1, minScore: 0.5 });
    expect(recalled[0]?.text).toContain("TypeScript");
  });

  it("isolates memories by scope", async () => {
    const memory = new AgentMemory({ search });
    await memory.add("alice likes tea", { scope: "alice" });
    await memory.add("bob likes coffee", { scope: "bob" });

    const aliceHits = await memory.recall("likes drink", { scope: "alice", topK: 5 });
    expect(aliceHits.every((h) => h.text.includes("alice"))).toBe(true);
  });

  it("respects minScore", async () => {
    const memory = new AgentMemory({ search, minScore: 0.99 });
    await memory.add("content about serverless databases");
    const hits = await memory.recall("cooking recipes for dinner", { topK: 5 });
    expect(hits).toHaveLength(0);
  });

  it("forgets a memory and keeps the registry in sync", async () => {
    const memory = new AgentMemory({ search, redis });
    const rec = await memory.add("ephemeral note", { scope: "u1" });
    expect(await memory.listIds("u1")).toContain(rec.id);

    await memory.forget(rec.id, { scope: "u1" });
    expect(await memory.listIds("u1")).not.toContain(rec.id);
    const hits = await memory.recall("ephemeral note", { scope: "u1", topK: 5 });
    expect(hits).toHaveLength(0);
  });

  it("throws on listIds without a redis client", async () => {
    const memory = new AgentMemory({ search });
    await expect(memory.listIds()).rejects.toThrow(/requires a `redis`/);
  });

  it("preserves custom metadata round-trip", async () => {
    const memory = new AgentMemory({ search });
    await memory.add("fact metadata example", { metadata: { source: "manual" } });
    const [hit] = await memory.recall("fact metadata", { topK: 1 });
    expect(hit!.metadata).toEqual({ source: "manual" });
  });
});
