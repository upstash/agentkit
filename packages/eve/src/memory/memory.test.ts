import { MemoryDocumentConflictError, fileMemory } from "eve/memory/file";
import type { MemoryProvider } from "eve/memory";
import { afterAll, describe, expect, it } from "vitest";
import { RedisMemoryDocumentBackend, redisDocuments } from "./index.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueUserId } from "../test-support.js";

const signal = new AbortController().signal;

/** eve's `recall["turn.started"]` handler, as a provider exposes it. */
type Recall = NonNullable<MemoryProvider["recall"]["turn.started"]>;

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
  sessionId?: string;
}) {
  return {
    abortSignal: signal,
    // eve's real contexts extend SessionContext; `conversations` is the only feature that reads it.
    session: { id: options.sessionId ?? "session-1", auth: { current: null } },
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

function callTool<R>(tools: unknown, name: string, input: unknown): Promise<R> {
  const tool = (tools as Record<string, { execute: (i: never, c: never) => unknown }>)[name];
  if (!tool) throw new Error(`tool ${name} not found`);
  return Promise.resolve(
    tool.execute(input as never, { abortSignal: signal } as never),
  ) as Promise<R>;
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

  // Regression for the CI failure that a single-region dev database could never reproduce: an
  // Upstash database replicates, and `@upstash/redis@1.38.0` sends its read-your-writes
  // `upstash-sync-token` one request late, so a read issued straight after a write can miss it and
  // report the document absent. `read()` confirms an "absent" answer for any key this instance has
  // written. Driven here through a scripted client so it is deterministic, not a race.
  it("confirms an 'absent' answer for a document it just wrote", async () => {
    const store = new Map<string, { content: string; version: string }>();
    let hmgets = 0;
    let lagging = true;
    const laggyRedis = {
      search: { index: () => ({}) },
      eval: (_script: string, keys: string[], args: string[]) => {
        store.set(keys[0]!, { content: args[0]!, version: args[2]! });
        return Promise.resolve([1, args[2]!]);
      },
      hmget: (key: string) => {
        hmgets += 1;
        // The first read after the write is served by a replica that hasn't caught up.
        if (lagging) {
          lagging = false;
          return Promise.resolve(null);
        }
        return Promise.resolve(store.get(key) ?? null);
      },
    } as never;

    const backend = new RedisMemoryDocumentBackend({ redis: laggyRedis });
    const written = await backend.write({
      key: "k",
      content: "doc",
      expectedVersion: null,
      signal,
    });
    expect(await backend.read({ key: "k", signal })).toEqual({
      content: "doc",
      version: written.version,
    });
    expect(hmgets).toBe(2); // one lagging read, one confirming re-read

    // A key this instance never wrote is reported absent on the FIRST read — no wasted round trip
    // on the common "no document yet" path.
    expect(await backend.read({ key: "unwritten", signal })).toBeNull();
    expect(hmgets).toBe(3);
  });

  it("still reports a document as absent when it is really gone", async () => {
    let hmgets = 0;
    const emptyRedis = {
      search: { index: () => ({}) },
      eval: (_script: string, _keys: string[], args: string[]) => Promise.resolve([1, args[2]!]),
      hmget: () => {
        hmgets += 1;
        return Promise.resolve(null);
      },
    } as never;

    const backend = new RedisMemoryDocumentBackend({ redis: emptyRedis });
    await backend.write({ key: "gone", content: "x", expectedVersion: null, signal });
    // e.g. `ttlSeconds` expired it: the confirming re-reads agree, so `null` is the answer.
    expect(await backend.read({ key: "gone", signal })).toBeNull();
    expect(hmgets).toBe(3); // the read plus its two confirmations, then it stops second-guessing
    expect(await backend.read({ key: "gone", signal })).toBeNull();
    expect(hmgets).toBe(4); // the key was forgotten, so no more confirmations
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
    // `ttl` is a raw metadata read, so it can't lean on `read()`'s confirming re-read; poll it
    // instead (see that method for why a read straight after a write can miss on a replica).
    const ttl = await pollUntil(
      () => redis.ttl(ttlBackend.keyFor("scope-ttl")),
      (value) => value > 0,
    );
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
