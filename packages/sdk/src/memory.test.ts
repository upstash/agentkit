import { afterAll, describe, expect, it } from "vitest";
import { AgentMemory } from "./memory.js";
import { hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

describe.skipIf(!hasRedisCreds)("AgentMemory (live Redis)", () => {
  const namespace = uniqueNamespace("memory");
  const memory = new AgentMemory({ redis: testRedis(), namespace });

  afterAll(async () => {
    try {
      await memory.searchIndex.drop();
    } catch {
      /* index may not exist */
    }
  });

  it("stores and fuzzily recalls memories", async () => {
    await memory.add("The user loves hiking in the mountains", { namespace: "recall" });
    await memory.add("The user is allergic to peanuts", { namespace: "recall" });
    await memory.searchIndex.waitIndexing();

    const recalled = await memory.recall("hiking mountains", { namespace: "recall", topK: 1 });
    expect(recalled[0]?.text).toContain("hiking");
    expect(recalled[0]?.score).toBeGreaterThan(0);
  });

  it("tolerates typos via fuzzy matching", async () => {
    await memory.add("The user prefers TypeScript", { namespace: "typo" });
    await memory.searchIndex.waitIndexing();
    const recalled = await memory.recall("typescrpt", { namespace: "typo", topK: 1 });
    expect(recalled[0]?.text).toContain("TypeScript");
  });

  it("isolates memories by namespace", async () => {
    await memory.add("alice likes green tea", { namespace: "alice" });
    await memory.add("bob likes black coffee", { namespace: "bob" });
    await memory.searchIndex.waitIndexing();

    const aliceHits = await memory.recall("likes drink", { namespace: "alice", topK: 5 });
    expect(aliceHits.length).toBeGreaterThan(0);
    expect(aliceHits.every((h) => h.text.includes("alice"))).toBe(true);
  });

  it("respects minScore", async () => {
    await memory.add("content about serverless databases", { namespace: "score" });
    await memory.searchIndex.waitIndexing();
    const hits = await memory.recall("serverless databases", { namespace: "score", minScore: 1e9 });
    expect(hits).toHaveLength(0);
  });

  it("recalls everything in a namespace when no query is given", async () => {
    await memory.add("first noteless memory", { namespace: "all" });
    await memory.add("second noteless memory", { namespace: "all" });
    await memory.searchIndex.waitIndexing();

    // No query → filter-only fetch; minScore is ignored, so a high floor still returns them.
    const hits = await memory.recall(undefined, { namespace: "all", topK: 10, minScore: 1e9 });
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits.every((h) => h.text.includes("noteless"))).toBe(true);
    // Scoped: another namespace sees none of them.
    expect(await memory.recall(undefined, { namespace: "all-other", topK: 10 })).toHaveLength(0);
  });

  it("falls back to everything when a query matches nothing", async () => {
    await memory.add("the user lives in Berlin", { namespace: "fb" });
    await memory.searchIndex.waitIndexing();
    // A query that won't fuzzily match still returns the namespace's memories (no empty result).
    const hits = await memory.recall("zzqqxx nonexistent topic", { namespace: "fb", topK: 10 });
    expect(hits.some((h) => h.text.includes("Berlin"))).toBe(true);
  });

  it("forgets a memory", async () => {
    const rec = await memory.add("ephemeral note to forget", { namespace: "forget" });
    await memory.searchIndex.waitIndexing();
    expect(
      await memory.recall("ephemeral note", { namespace: "forget", topK: 5 }),
    ).not.toHaveLength(0);

    await memory.forget(rec.id, { namespace: "forget" });
    await memory.searchIndex.waitIndexing();
    expect(await memory.recall("ephemeral note", { namespace: "forget", topK: 5 })).toHaveLength(0);
  });

  // namespace is the only tenant boundary — an empty/missing one must throw (never silently collapse
  // into a shared "default" bucket). Validated before any Redis call.
  it("requires a non-empty namespace on add / recall / forget", async () => {
    await expect(memory.add("x", { namespace: "" })).rejects.toThrow(/namespace/i);
    await expect(memory.add("x", { namespace: undefined as unknown as string })).rejects.toThrow(
      /namespace/i,
    );
    await expect(memory.recall("q", { namespace: "" })).rejects.toThrow(/namespace/i);
    await expect(memory.recall(undefined, { namespace: "" })).rejects.toThrow(/namespace/i);
    await expect(memory.forget("some-id", { namespace: "" })).rejects.toThrow(/namespace/i);
  });

  it("preserves custom metadata and createdAt round-trip", async () => {
    await memory.add("fact metadata example", {
      namespace: "meta",
      metadata: { source: "manual" },
    });
    await memory.searchIndex.waitIndexing();
    const [hit] = await memory.recall("fact metadata", { namespace: "meta", topK: 1 });
    expect(hit?.metadata).toEqual({ source: "manual" });
    expect(hit?.createdAt).toBeGreaterThan(0);
  });
});
