import { s } from "@upstash/redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentMemory } from "./memory.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniquePrefix } from "./test-support.js";

/**
 * Create the index *before* anything is seeded into its keyspace. A doc written while the index is
 * still missing can be dropped by the create-time backfill **permanently** (not just late), and
 * `waitIndexing()` on an index that does not exist yet is a silent no-op — so seeding first and
 * letting the first read provision reactively is a coin flip. Any read provisions: `count` returns
 * the `{count: -1}` sentinel on a missing index, which makes the reactive wrapper create it, wait
 * for indexing, and retry.
 */
async function provision<TSchema>(memory: AgentMemory<TSchema>) {
  await memory.count({ userId: "provision-probe" });
}

/** Poll a read until it reflects a just-written doc — insurance for residual indexing lag. */
async function pollUntil<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8_000; // well inside vitest's 30s testTimeout
  let value = await read();
  while (!ready(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    value = await read();
  }
  return value;
}

describe.skipIf(!hasRedisCreds)("AgentMemory (live Redis)", () => {
  const prefix = uniquePrefix("memory");
  const memory = new AgentMemory({ redis: testRedis(), prefix });

  beforeAll(() => provision(memory));

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

    const recalled = await pollUntil(
      () => memory.recall({ query: "hiking mountains", userId: "recall", topK: 1 }),
      (hits) => hits.length > 0,
    );
    expect(recalled[0]?.text).toContain("hiking");
    expect(recalled[0]?.score).toBeGreaterThan(0);
  });

  it("tolerates typos via fuzzy matching", async () => {
    await memory.add({ text: "The user prefers TypeScript", userId: "typo" });
    await memory.searchIndex.waitIndexing();
    const recalled = await pollUntil(
      () => memory.recall({ query: "typescrpt", userId: "typo", topK: 1 }),
      (hits) => hits.length > 0,
    );
    expect(recalled[0]?.text).toContain("TypeScript");
  });

  it("isolates memories by userId", async () => {
    await memory.add({ text: "alice likes green tea", userId: "alice" });
    await memory.add({ text: "bob likes black coffee", userId: "bob" });
    await memory.searchIndex.waitIndexing();

    const aliceHits = await pollUntil(
      () => memory.recall({ query: "likes drink", userId: "alice", topK: 5 }),
      (hits) => hits.length > 0,
    );
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
    const hits = await pollUntil(
      () => memory.recall({ userId: "all", topK: 10, minScore: 1e9 }),
      (found) => found.length >= 2,
    );
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits.every((h) => h.text.includes("noteless"))).toBe(true);
    // Scoped: another user sees none of them.
    expect(await memory.recall({ userId: "all-other", topK: 10 })).toHaveLength(0);
  });

  it("returns nothing when a query matches nothing", async () => {
    await memory.add({ text: "the user lives in Berlin", userId: "fb" });
    await memory.searchIndex.waitIndexing();
    // Establish that the doc is visible *first*, so the miss below is a real miss and not just a
    // doc that hasn't been indexed yet — otherwise this test passes for the wrong reason.
    const all = await pollUntil(
      () => memory.recall({ userId: "fb", topK: 10 }),
      (hits) => hits.some((h) => h.text.includes("Berlin")),
    );
    expect(all.some((h) => h.text.includes("Berlin"))).toBe(true);
    // No fallback to "everything for the user": a miss answered with unrelated memories is
    // indistinguishable from a hit to whoever asked.
    expect(
      await memory.recall({ query: "zzqqxx nonexistent topic", userId: "fb", topK: 10 }),
    ).toEqual([]);
  });

  it("forgets a memory", async () => {
    const rec = await memory.add({ text: "ephemeral note to forget", userId: "forget" });
    await memory.searchIndex.waitIndexing();
    expect(
      await pollUntil(
        () => memory.recall({ query: "ephemeral note", userId: "forget", topK: 5 }),
        (hits) => hits.length > 0,
      ),
    ).not.toHaveLength(0);

    await memory.forget(rec.id, { userId: "forget" });
    await memory.searchIndex.waitIndexing();
    expect(
      await pollUntil(
        () => memory.recall({ query: "ephemeral note", userId: "forget", topK: 5 }),
        (hits) => hits.length === 0,
      ),
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
    const [hit] = await pollUntil(
      () => memory.recall({ query: "dated fact", userId: "meta", topK: 1 }),
      (hits) => hits.length > 0,
    );
    expect(hit?.createdAt).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------------------------------------
// Extended stores: metadataSchema + metadata
// -------------------------------------------------------------------------------------------

describe.skipIf(!hasRedisCreds)("AgentMemory with metadataSchema (live Redis)", () => {
  const redis = testRedis();
  const prefix = uniquePrefix("memory-meta");
  // No metadata type is written down: the store's `metadata` shape and the fields its `filter`
  // accepts are both derived from `metadataSchema` below.
  const memory = new AgentMemory({
    redis,
    prefix,
    metadataSchema: {
      source: s.string().noTokenize(),
      deleted: s.boolean(),
      slot: s.number(),
    },
  });

  beforeAll(() => provision(memory));

  afterAll(async () => {
    try {
      await memory.searchIndex.drop();
    } catch {
      /* index may not exist */
    }
    await cleanupKeys(redis, prefix);
  });

  it("round-trips metadata through add and recall", async () => {
    await memory.add({
      text: "The user commutes by folding bike",
      userId: "meta",
      metadata: { source: "agent", deleted: false, slot: 3 },
    });
    await memory.searchIndex.waitIndexing();

    const [hit] = await pollUntil(
      () => memory.recall({ query: "folding bike", userId: "meta", topK: 5 }),
      (hits) => hits.length > 0,
    );
    expect(hit?.text).toContain("folding bike");
    // Declared fields come back typed, with their values intact — including a non-string one.
    expect(hit?.metadata).toEqual({ source: "agent", deleted: false, slot: 3 });
  });

  it("filters a ranked recall by a metadata field", async () => {
    await memory.add({
      text: "The user reviews pull requests on Mondays",
      userId: "filter",
      metadata: { source: "agent", deleted: false, slot: 1 },
    });
    await memory.add({
      text: "I review pull requests whenever I get a chance",
      userId: "filter",
      metadata: { source: "userMessage", deleted: false, slot: 1 },
    });
    await memory.searchIndex.waitIndexing();

    const all = await pollUntil(
      () => memory.recall({ query: "review pull requests", userId: "filter", topK: 10 }),
      (hits) => hits.length === 2,
    );
    expect(all.length).toBe(2);

    // The point of indexing metadata: one kind can be retrieved without the other competing for
    // the same `topK`, which no amount of ranking could guarantee.
    const facts = await memory.recall({
      query: "review pull requests",
      userId: "filter",
      topK: 10,
      filter: { source: { $eq: "agent" } },
    });
    expect(facts.map((h) => h.metadata?.source)).toEqual(["agent"]);
  });

  it("list() reads by filter alone, and count() reports without fetching", async () => {
    for (const [i, source] of ["agent", "userMessage", "userMessage"].entries()) {
      await memory.add({
        text: `listable memory number ${i}`,
        userId: "listing",
        metadata: { source, deleted: false, slot: i },
      });
    }
    await memory.searchIndex.waitIndexing();

    const messages = await pollUntil(
      () => memory.list({ userId: "listing", filter: { source: { $eq: "userMessage" } } }),
      (hits) => hits.length === 2,
    );
    expect(messages).toHaveLength(2);
    // Unranked: `list` is the filter-first read, so every hit scores the same.
    expect(messages.every((m) => m.metadata?.source === "userMessage")).toBe(true);

    expect(await memory.count({ userId: "listing" })).toBe(3);
    expect(await memory.count({ userId: "listing", filter: { source: { $eq: "agent" } } })).toBe(1);
  });

  it("a filter on a field the record lacks hides it — which is why an extended store needs its own prefix", async () => {
    // Written the way an older release wrote it: no `deleted`, no `source`.
    await redis.json.set(`${prefix}:legacy:aaaaaaaaaaaa`, "$", {
      text: "written before the schema was extended",
      userId: "legacy",
      createdAt: Date.now(),
    });
    await memory.searchIndex.waitIndexing();

    // Visible on its own...
    expect(
      await pollUntil(
        () => memory.list({ userId: "legacy" }),
        (hits) => hits.length === 1,
      ),
    ).toHaveLength(1);
    // ...and invisible to any filter naming a field it does not carry. Upstash Search does not
    // match a missing field against `{$eq: …}` and has no `$ne`, so there is no filter-level
    // workaround: this is the whole reason an extended schema must not cover a keyspace that
    // already holds records written without its fields.
    expect(
      await memory.list({ userId: "legacy", filter: { deleted: { $eq: false } } }),
    ).toHaveLength(0);
  });
});

describe.skipIf(!hasRedisCreds)("AgentMemory without metadataSchema is unchanged", () => {
  const redis = testRedis();
  const prefix = uniquePrefix("memory-plain");
  const memory = new AgentMemory({ redis, prefix });

  beforeAll(() => provision(memory));

  afterAll(async () => {
    try {
      await memory.searchIndex.drop();
    } catch {
      /* index may not exist */
    }
    await cleanupKeys(redis, prefix);
  });

  it("stores no extra fields and reads records written without them", async () => {
    // A record written by a release that predates `metadataSchema`.
    await redis.json.set(`${prefix}:plain:bbbbbbbbbbbb`, "$", {
      text: "the user lives in Berlin",
      userId: "plain",
      createdAt: Date.now(),
    });
    await memory.add({ text: "the user works in Munich", userId: "plain" });
    await memory.searchIndex.waitIndexing();

    // Both are recallable: an unextended store declares the same two indexed fields it always did,
    // so nothing already in its keyspace falls out of scope.
    const hits = await pollUntil(
      () => memory.recall({ userId: "plain", topK: 10 }),
      (found) => found.length === 2,
    );
    expect(hits.map((h) => h.text).sort()).toEqual([
      "the user lives in Berlin",
      "the user works in Munich",
    ]);
    // And `metadata` is absent rather than an empty object, so callers can tell it was never declared.
    expect(hits.every((h) => h.metadata === undefined)).toBe(true);

    const doc = (await redis.json.get(`${prefix}:plain:bbbbbbbbbbbb`)) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(["createdAt", "text", "userId"]);
  });
});
