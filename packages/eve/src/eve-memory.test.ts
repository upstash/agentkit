import { AgentMemory } from "@upstash/agentkit-sdk";
import { MemoryDocumentConflictError, fileMemory } from "eve/memory/file";
import type { MemoryProvider } from "eve/memory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RedisMemoryDocumentBackend,
  defaultExtract,
  redisDocuments,
  redisMemory,
} from "./eve-memory.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueUserId } from "./test-support.js";

const signal = new AbortController().signal;

/**
 * A stand-in Redis client for the offline suite: enough surface for the constructors (which build a
 * `ReactiveSearchIndex` eagerly) without any network. The offline tests never issue a command.
 */
const offlineRedis = { search: { index: () => ({}) } } as never;

/**
 * Re-run `read` until `ready` holds (or the deadline passes) and return the last value, so a caller
 * asserting on search results doesn't race Upstash's asynchronous indexing.
 */
async function pollUntil<R>(read: () => Promise<R>, ready: (value: R) => boolean): Promise<R> {
  const deadline = Date.now() + 8_000;
  let value = await read();
  while (!ready(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    value = await read();
  }
  return value;
}

/** A user-role AI SDK `ModelMessage`. */
const userMessage = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

/**
 * The slice of eve's memory operation context our provider actually reads. eve builds the real
 * thing from a locked scope; the fields below are the ones a provider is contractually handed.
 */
function operationContext(options: {
  scopeKey: string;
  slot?: string;
  operationId?: string;
  input?: unknown[];
  messages?: unknown[];
}) {
  return {
    abortSignal: signal,
    memory: {
      scope: {
        key: options.scopeKey,
        namespace: "agentkit-tests",
        value: options.scopeKey,
      },
      slot: options.slot ?? "recall",
    },
    messages: options.messages ?? [],
    operationId: options.operationId ?? `op-${Math.random().toString(36).slice(2)}`,
    turn: { id: "turn-1", input: options.input ?? [], sequence: 1 },
  };
}

type Recall = NonNullable<MemoryProvider["recall"]["turn.started"]>;
type Capture = NonNullable<NonNullable<MemoryProvider["capture"]>["turn.completed"]>;

/** Run a provider's `turn.started` recall and return the single keyed message's content. */
async function recallContent(
  provider: MemoryProvider,
  context: ReturnType<typeof operationContext>,
): Promise<string> {
  const result = await (provider.recall["turn.started"] as Recall)(context as never);
  expect(result?.messages).toHaveLength(1);
  return result!.messages[0]!.content;
}

/** Call a memory-provider tool's executor. eve types provider tool input as `never`, so tests
 * narrow it themselves (the same shape as the memory-tool tests in `memory.test.ts`). */
function callTool<R>(tools: unknown, name: string, input: unknown): Promise<R> {
  const tool = (tools as Record<string, { execute: (i: never, c: never) => unknown }>)[name];
  if (!tool) throw new Error(`tool ${name} not found`);
  return Promise.resolve(
    tool.execute(input as never, { abortSignal: signal } as never),
  ) as Promise<R>;
}

async function captureTurn(
  provider: MemoryProvider,
  context: ReturnType<typeof operationContext>,
): Promise<void> {
  await (provider.capture!["turn.completed"] as Capture)(context as never);
}

// -------------------------------------------------------------------------------------------
// Offline
// -------------------------------------------------------------------------------------------

describe("eve memory integration (offline)", () => {
  it("redisDocuments() implements eve's MemoryDocumentBackend surface", () => {
    // No Redis calls happen in the constructor, but `Redis.fromEnv()` would throw without creds.
    const backend = redisDocuments({ redis: offlineRedis });
    expect(typeof backend.read).toBe("function");
    expect(typeof backend.write).toBe("function");
  });

  it("redisMemory() implements eve's MemoryProvider surface", () => {
    const provider = redisMemory({ redis: offlineRedis });
    // eve requires `recall["turn.started"]`; the other three handlers are optional but we register
    // all of them, which is what makes recall and capture automatic.
    expect(typeof provider.recall["turn.started"]).toBe("function");
    expect(typeof provider.recall["compaction.completed"]).toBe("function");
    expect(typeof provider.capture?.["turn.completed"]).toBe("function");
    expect(typeof provider.capture?.["compaction.requested"]).toBe("function");
    expect(typeof provider.tools).toBe("function");
  });

  it("capture and tools can be turned off", () => {
    const provider = redisMemory({ redis: offlineRedis, capture: false, tools: false });
    expect(provider.capture).toBeUndefined();
    expect(provider.tools).toBeUndefined();
    // Recall stays — eve requires it.
    expect(typeof provider.recall["turn.started"]).toBe("function");
  });

  it("default capture reads only user-authored text of the settled turn", () => {
    const context = operationContext({
      scopeKey: "scope",
      input: [
        userMessage("  I  prefer   dark mode "),
        { role: "assistant", content: [{ type: "text", text: "Noted." }] },
        { role: "user", content: "and I live in Berlin" },
        userMessage("   "),
      ],
    });
    // Assistant output is never captured; whitespace is normalized; blanks are dropped.
    expect(defaultExtract(context as never)).toEqual([
      "I prefer dark mode",
      "and I live in Berlin",
    ]);
  });

  it("default capture stores nothing when a compaction has no active turn", () => {
    // `compaction.requested` can arrive with `turn: null` (standalone compaction).
    expect(defaultExtract({ turn: null, messages: [] } as never)).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------
// 1. MemoryDocumentBackend (live Redis)
// -------------------------------------------------------------------------------------------

describe.skipIf(!hasRedisCreds)("redisDocuments() — MemoryDocumentBackend (live Redis)", () => {
  const redis = testRedis();
  const prefix = `test:memfile:${uniqueUserId("doc")}`;
  const backend = new RedisMemoryDocumentBackend({ redis, prefix });
  const key = "scope-a";

  afterAll(async () => {
    await cleanupKeys(redis, prefix);
  });

  it("reads null for a scope that has never been written", async () => {
    expect(await backend.read({ key: "never-written", signal })).toBeNull();
  });

  it("creates with expectedVersion null, then round-trips through read", async () => {
    const written = await backend.write({
      key,
      content: "first",
      expectedVersion: null,
      signal,
    });
    expect(written.content).toBe("first");
    expect(written.version).not.toBe("");

    const read = await backend.read({ key, signal });
    expect(read).toEqual({ content: "first", version: written.version });
  });

  it("throws eve's MemoryDocumentConflictError on a create that races another create", async () => {
    // The document now exists, so a second create-only write (expectedVersion null) must conflict.
    await expect(
      backend.write({ key, content: "clobber", expectedVersion: null, signal }),
    ).rejects.toThrow(MemoryDocumentConflictError);
    expect((await backend.read({ key, signal }))?.content).toBe("first");
  });

  it("throws MemoryDocumentConflictError on a stale expectedVersion, and .is() narrows it", async () => {
    const stale = (await backend.read({ key, signal }))!;
    // Someone else writes first.
    const fresh = await backend.write({
      key,
      content: "second",
      expectedVersion: stale.version,
      signal,
    });
    // Our write still carries the pre-write version.
    const error = await backend
      .write({ key, content: "third", expectedVersion: stale.version, signal })
      .then(
        () => null,
        (e: unknown) => e,
      );
    // `.is()` is how eve's fileMemory() detects the conflict across bundle boundaries — it must
    // hold, not just `instanceof`.
    expect(MemoryDocumentConflictError.is(error)).toBe(true);
    expect((error as MemoryDocumentConflictError).key).toBe(key);
    expect((await backend.read({ key, signal }))?.content).toBe("second");
    expect((await backend.read({ key, signal }))?.version).toBe(fresh.version);
  });

  // The whole point of the Lua script: on Upstash's REST API there is no WATCH/MULTI, so without a
  // server-side compare-and-set concurrent writers would all "succeed" and silently lose data.
  it("lets exactly one of N concurrent writers win (atomic compare-and-set)", async () => {
    const raceKey = "scope-race";
    await backend.write({ key: raceKey, content: "base", expectedVersion: null, signal });
    const base = (await backend.read({ key: raceKey, signal }))!;

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        backend.write({
          key: raceKey,
          content: `writer-${i}`,
          expectedVersion: base.version,
          signal,
        }),
      ),
    );
    const winners = results.filter((r) => r.status === "fulfilled");
    const losers = results.filter((r) => r.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(7);
    expect(losers.every((r) => MemoryDocumentConflictError.is(r.reason))).toBe(true);

    // The stored document is the winner's, and its version is the one the winner reported.
    const stored = (await backend.read({ key: raceKey, signal }))!;
    const winner = (winners[0] as PromiseFulfilledResult<{ content: string; version: string }>)
      .value;
    expect(stored).toEqual(winner);
  });

  // `@upstash/redis` auto-deserializes replies, so a document that happens to be valid JSON would
  // come back as a number/object without the storage marker. Documents must survive byte-for-byte.
  it("round-trips documents that look like JSON", async () => {
    for (const [i, content] of ['{"a": 1}', "123", "  true  ", "[1,2,3]", "null"].entries()) {
      const jsonKey = `scope-json-${i}`;
      await backend.write({ key: jsonKey, content, expectedVersion: null, signal });
      const read = await backend.read({ key: jsonKey, signal });
      expect(read?.content).toBe(content);
      expect(typeof read?.content).toBe("string");
    }
  });

  it("applies ttlSeconds inside the same write", async () => {
    const ttlBackend = new RedisMemoryDocumentBackend({ redis, prefix, ttlSeconds: 120 });
    await ttlBackend.write({ key: "scope-ttl", content: "x", expectedVersion: null, signal });
    const ttl = await redis.ttl(ttlBackend.keyFor("scope-ttl"));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it("honours an aborted signal before touching Redis", async () => {
    const aborted = AbortSignal.abort();
    await expect(backend.read({ key, signal: aborted })).rejects.toThrow();
    await expect(
      backend.write({ key, content: "x", expectedVersion: null, signal: aborted }),
    ).rejects.toThrow();
  });
});

// -------------------------------------------------------------------------------------------
// eve's REAL fileMemory() provider, driven over our backend (live Redis)
// -------------------------------------------------------------------------------------------

describe.skipIf(!hasRedisCreds)("eve fileMemory() over redisDocuments() (live Redis)", () => {
  const redis = testRedis();
  const prefix = `test:memfile:${uniqueUserId("file")}`;
  const scopeKey = "scope-file-memory";
  const provider = fileMemory({ backend: redisDocuments({ redis, prefix }) });
  const context = operationContext({ scopeKey, slot: "profile" });

  afterAll(async () => {
    await cleanupKeys(redis, prefix);
  });

  it("recalls nothing before anything is saved", async () => {
    const result = await (provider.recall["turn.started"] as Recall)(context as never);
    expect(result ?? null).toBeNull();
  });

  it("saves through eve's own save_memory tool and recalls the document back", async () => {
    const tools = await provider.tools!({
      ...context,
      turn: { id: "turn-1", input: [], sequence: 1 },
    } as never);
    expect(Object.keys(tools!).sort()).toEqual(["remove_memory", "save_memory"]);

    await callTool(tools, "save_memory", { text: "The user prefers dark mode" });
    await callTool(tools, "save_memory", { text: "The user lives in Berlin" });

    const result = await (provider.recall["turn.started"] as Recall)(context as never);
    const content = result!.messages[0]!.content;
    expect(content).toContain("0: The user prefers dark mode");
    expect(content).toContain("1: The user lives in Berlin");

    // eve keys the whole document as one recall item, so an updated document supersedes the old one.
    expect(result!.messages[0]!.id).toBe("file-memory-document");
  });

  it("removes an entry through eve's remove_memory tool", async () => {
    const tools = await provider.tools!({
      ...context,
      turn: { id: "turn-2", input: [], sequence: 2 },
    } as never);
    await callTool(tools, "remove_memory", { index: 0 });

    const result = await (provider.recall["turn.started"] as Recall)(context as never);
    const content = result!.messages[0]!.content;
    expect(content).not.toContain("dark mode");
    expect(content).toContain("1: The user lives in Berlin");
  });
});

// -------------------------------------------------------------------------------------------
// 2. MemoryProvider over AgentMemory (live Redis)
// -------------------------------------------------------------------------------------------

describe.skipIf(!hasRedisCreds)("redisMemory() — MemoryProvider (live Redis)", () => {
  const redis = testRedis();
  // Reuse the default `agentkit:memory` prefix (and therefore its shared search index) — an Upstash
  // database caps at 10 indexes, so a memory slot must not mint its own. Isolation is by scope key.
  const scopeKey = uniqueUserId("eve-slot");
  const provider = redisMemory({ redis, topK: 5 });
  // A throwaway handle on the same default index, to provision it and wait for indexing.
  const index = new AgentMemory({ redis }).searchIndex;

  beforeAll(async () => {
    // Provision BEFORE any write: a doc written while the index is still missing can be dropped by
    // the create-time backfill permanently, not just late.
    await index.query({ filter: { userId: { $eq: "nobody" } }, limit: 1 } as never);
  });

  afterAll(async () => {
    await cleanupKeys(redis, `agentkit:memory:${scopeKey}`);
    await cleanupKeys(redis, `agentkit:memoryRecall:${scopeKey}`);
  });

  it("recalls an explicit empty block for a scope with no memories", async () => {
    const content = await recallContent(
      provider,
      operationContext({ scopeKey, input: [userMessage("hi")] }),
    );
    expect(content).toContain("# Recalled memories for recall");
    expect(content).toContain("No memories are stored");
  });

  it("captures the turn's user text and recalls it on a later turn", async () => {
    await captureTurn(
      provider,
      operationContext({
        scopeKey,
        input: [
          userMessage("I prefer dark mode in every editor"),
          { role: "assistant", content: "Got it." },
        ],
      }),
    );
    await index.waitIndexing();

    const content = await pollUntil(
      () =>
        recallContent(
          provider,
          operationContext({ scopeKey, input: [userMessage("what theme do I like?")] }),
        ),
      (c) => c.includes("dark mode"),
    );
    expect(content).toContain("dark mode");
    // Each line is `<id>: <text>` so the model can call forget_memory with the id.
    expect(content).toMatch(/^[0-9a-f]{12}: I prefer dark mode in every editor$/m);
    expect(content).toContain("recall__forget_memory");
  });

  it("is idempotent: capturing the same text twice stores one memory", async () => {
    const before = await redis.keys(`agentkit:memory:${scopeKey}:*`);
    await captureTurn(
      provider,
      operationContext({ scopeKey, input: [userMessage("I prefer dark mode in every editor")] }),
    );
    const after = await redis.keys(`agentkit:memory:${scopeKey}:*`);
    expect(after.sort()).toEqual(before.sort());
  });

  it("never captures assistant or tool output", async () => {
    const isolated = uniqueUserId("eve-slot-assistant");
    await captureTurn(
      provider,
      operationContext({
        scopeKey: isolated,
        input: [
          { role: "assistant", content: "The capital of France is Paris." },
          { role: "tool", content: [{ type: "text", text: "tool output" }] },
        ],
      }),
    );
    expect(await redis.keys(`agentkit:memory:${isolated}:*`)).toEqual([]);
  });

  it("skips over-long turns rather than truncating them", async () => {
    const isolated = uniqueUserId("eve-slot-long");
    const small = redisMemory({ redis, maxEntryCharacters: 20 });
    await captureTurn(
      small,
      operationContext({
        scopeKey: isolated,
        input: [userMessage("this message is definitely longer than twenty characters")],
      }),
    );
    expect(await redis.keys(`agentkit:memory:${isolated}:*`)).toEqual([]);
  });

  // eve records a digest of each recall and throws if the same operationId replays differently.
  it("returns a byte-identical result when eve replays the same operationId", async () => {
    const operationId = `replay-${uniqueUserId("op")}`;
    const first = await recallContent(
      provider,
      operationContext({ scopeKey, operationId, input: [userMessage("theme")] }),
    );

    // Something else writes to the same scope between the original run and the replay.
    await captureTurn(
      provider,
      operationContext({ scopeKey, input: [userMessage("I also use a mechanical keyboard")] }),
    );
    await index.waitIndexing();

    const replay = await recallContent(
      provider,
      operationContext({ scopeKey, operationId, input: [userMessage("theme")] }),
    );
    expect(replay).toBe(first);

    // A *new* operation does see the new memory (the cache is per-operation, not a stale read).
    const fresh = await pollUntil(
      () =>
        recallContent(
          provider,
          operationContext({ scopeKey, input: [userMessage("what do I type on?")] }),
        ),
      (c) => c.includes("mechanical keyboard"),
    );
    expect(fresh).toContain("mechanical keyboard");
  });

  it("contributes save_memory / forget_memory bound to the locked scope", async () => {
    const tools = await provider.tools!(operationContext({ scopeKey, slot: "recall" }) as never);
    expect(Object.keys(tools!).sort()).toEqual(["forget_memory", "save_memory"]);

    const saved = await callTool<{ id: string; saved: boolean }>(tools, "save_memory", {
      text: "The user's cat is called Ada",
    });
    expect(saved.saved).toBe(true);
    await index.waitIndexing();

    const content = await pollUntil(
      () =>
        recallContent(
          provider,
          operationContext({ scopeKey, input: [userMessage("what is my cat called?")] }),
        ),
      (c) => c.includes("Ada"),
    );
    expect(content).toContain(`${saved.id}: The user's cat is called Ada`);

    // forget_memory is the capability eve's own file memory can only approximate by index.
    await callTool(tools, "forget_memory", { id: saved.id });
    expect(await redis.exists(`agentkit:memory:${scopeKey}:${saved.id}`)).toBe(0);
  });

  it("rejects a model-supplied memory id that could address another scope's key", async () => {
    const tools = await provider.tools!(operationContext({ scopeKey }) as never);
    await expect(callTool(tools, "forget_memory", { id: "../../other:key" })).rejects.toThrow(
      /not a valid memory id/,
    );
  });
});
