import { afterAll, describe, expect, it } from "vitest";
import { AgentMemory } from "./memory.js";
import { hasRedisCreds, testRedis, uniquePrefix } from "./test-support.js";

describe.skipIf(!hasRedisCreds)("AgentMemory (live Redis)", () => {
  const prefix = uniquePrefix("memory");
  const memory = new AgentMemory({ redis: testRedis(), prefix });

  afterAll(async () => {
    try {
      await memory.searchIndex.drop();
    } catch {
      /* index may not exist */
    }
  });

  it("stores and fuzzily recalls memories", async () => {
    await memory.add({ text: "The user loves hiking in the mountains", userId: "recall" });
    await memory.add({ text: "The user is allergic to peanuts", userId: "recall" });
    await memory.searchIndex.waitIndexing();

    const recalled = await memory.recall({ query: "hiking mountains", userId: "recall", topK: 1 });
    expect(recalled[0]?.text).toContain("hiking");
    expect(recalled[0]?.score).toBeGreaterThan(0);
  });

  it("tolerates typos via fuzzy matching", async () => {
    await memory.add({ text: "The user prefers TypeScript", userId: "typo" });
    await memory.searchIndex.waitIndexing();
    const recalled = await memory.recall({ query: "typescrpt", userId: "typo", topK: 1 });
    expect(recalled[0]?.text).toContain("TypeScript");
  });

  it("isolates memories by userId", async () => {
    await memory.add({ text: "alice likes green tea", userId: "alice" });
    await memory.add({ text: "bob likes black coffee", userId: "bob" });
    await memory.searchIndex.waitIndexing();

    const aliceHits = await memory.recall({ query: "likes drink", userId: "alice", topK: 5 });
    expect(aliceHits.length).toBeGreaterThan(0);
    expect(aliceHits.every((h) => h.text.includes("alice"))).toBe(true);
  });

  it("respects minScore", async () => {
    await memory.add({ text: "content about serverless databases", userId: "score" });
    await memory.searchIndex.waitIndexing();
    const hits = await memory.recall({
      query: "serverless databases",
      userId: "score",
      minScore: 1e9,
    });
    expect(hits).toHaveLength(0);
  });

  it("recalls everything for a user when no query is given", async () => {
    await memory.add({ text: "first noteless memory", userId: "all" });
    await memory.add({ text: "second noteless memory", userId: "all" });
    await memory.searchIndex.waitIndexing();

    // No query → filter-only fetch; minScore is ignored, so a high floor still returns them.
    const hits = await memory.recall({ userId: "all", topK: 10, minScore: 1e9 });
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits.every((h) => h.text.includes("noteless"))).toBe(true);
    // Scoped: another user sees none of them.
    expect(await memory.recall({ userId: "all-other", topK: 10 })).toHaveLength(0);
  });

  it("falls back to everything when a query matches nothing", async () => {
    await memory.add({ text: "the user lives in Berlin", userId: "fb" });
    await memory.searchIndex.waitIndexing();
    // A query that won't fuzzily match still returns the user's memories (no empty result).
    const hits = await memory.recall({ query: "zzqqxx nonexistent topic", userId: "fb", topK: 10 });
    expect(hits.some((h) => h.text.includes("Berlin"))).toBe(true);
  });

  it("forgets a memory", async () => {
    const rec = await memory.add({ text: "ephemeral note to forget", userId: "forget" });
    await memory.searchIndex.waitIndexing();
    expect(
      await memory.recall({ query: "ephemeral note", userId: "forget", topK: 5 }),
    ).not.toHaveLength(0);

    await memory.forget(rec.id, { userId: "forget" });
    await memory.searchIndex.waitIndexing();
    expect(
      await memory.recall({ query: "ephemeral note", userId: "forget", topK: 5 }),
    ).toHaveLength(0);
  });

  // userId is the only tenant boundary — an empty/missing one must throw (never silently collapse
  // into a shared bucket). Validated before any Redis call.
  it("requires a non-empty userId on add / recall / forget", async () => {
    await expect(memory.add({ text: "x", userId: "" })).rejects.toThrow(/userId/i);
    await expect(memory.add({ text: "x", userId: undefined as unknown as string })).rejects.toThrow(
      /userId/i,
    );
    await expect(memory.recall({ query: "q", userId: "" })).rejects.toThrow(/userId/i);
    await expect(memory.recall({ userId: "" })).rejects.toThrow(/userId/i);
    await expect(memory.forget("some-id", { userId: "" })).rejects.toThrow(/userId/i);
  });

  it("rejects a userId containing the ':' key separator (no cross-user key collision)", async () => {
    await expect(memory.add({ text: "x", userId: "a:b" })).rejects.toThrow(/':'/);
    await expect(memory.recall({ userId: "a:b" })).rejects.toThrow(/':'/);
    await expect(memory.forget("id", { userId: "a:b" })).rejects.toThrow(/':'/);
  });

  it("round-trips createdAt", async () => {
    await memory.add({ text: "a dated fact", userId: "meta" });
    await memory.searchIndex.waitIndexing();
    const [hit] = await memory.recall({ query: "dated fact", userId: "meta", topK: 1 });
    expect(hit?.createdAt).toBeGreaterThan(0);
  });
});
