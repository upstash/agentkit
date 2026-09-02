import { AgentMemory, stableHash } from "@upstash/agentkit-sdk";
import { MemoryDocumentConflictError, fileMemory } from "eve/memory/file";
import type { MemoryProvider } from "eve/memory";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RedisMemoryDocumentBackend, redisDocuments, redisMemory } from "./index.js";
import type { RedisMemoryConfig } from "./index.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueUserId } from "../test-support.js";

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

type Recall = NonNullable<MemoryProvider["recall"]["turn.started"]>;
type Capture = NonNullable<NonNullable<MemoryProvider["capture"]>["turn.completed"]>;

/** The two lifecycle points eve can ask a provider to recall at. */
type RecallHook = "turn.started" | "compaction.completed";
/** The two lifecycle points eve can ask a provider to capture at. */
type CaptureHook = "turn.completed" | "compaction.requested";

/**
 * Run a provider's recall at `hook` and return the single keyed message's content. Both hooks go
 * through here so `compaction.completed` — the one eve only reaches after a compaction checkpoint,
 * and so the easiest to leave wired-but-broken — is exercised exactly like `turn.started`.
 */
async function recallAt(
  provider: MemoryProvider,
  hook: RecallHook,
  context: ReturnType<typeof operationContext>,
): Promise<string> {
  const handler = provider.recall[hook] as Recall | undefined;
  if (!handler) throw new Error("no recall handler for " + hook);
  const result = await handler(context as never);
  expect(result?.messages).toHaveLength(1);
  // eve keys the whole block so a later recall supersedes it rather than stacking.
  expect(result!.messages[0]!.id).toBe("agentkit-redis-memory");
  return result!.messages[0]!.content;
}

/** Run a provider's `turn.started` recall and return the single keyed message's content. */
function recallContent(
  provider: MemoryProvider,
  context: ReturnType<typeof operationContext>,
): Promise<string> {
  return recallAt(provider, "turn.started", context);
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

/** Run a provider's capture at `hook`. */
async function captureAt(
  provider: MemoryProvider,
  hook: CaptureHook,
  context: ReturnType<typeof operationContext>,
): Promise<void> {
  const handler = provider.capture?.[hook] as Capture | undefined;
  if (!handler) throw new Error("no capture handler for " + hook);
  await handler(context as never);
}

function captureTurn(
  provider: MemoryProvider,
  context: ReturnType<typeof operationContext>,
): Promise<void> {
  return captureAt(provider, "turn.completed", context);
}

/** One row as `AgentMemory` reads them back off the Redis Search index. */
interface ScriptedRow {
  key: string;
  score: number;
  data: { text: string; createdAt: number };
}

/**
 * A scripted stand-in for the Redis client that records what `redisMemory()` actually asks Redis
 * for. Where the live suites prove the round trip, this proves the *shape* of it — which index,
 * which filter, how many queries, which documents — with no dependence on BM25 scoring or on
 * Upstash's asynchronous indexing.
 */
function scriptedRedis(initialRows: ScriptedRow[] = []) {
  let rows = initialRows;
  const indexOptions: { name?: string }[] = [];
  const queries: { filter: Record<string, unknown>; limit: number }[] = [];
  const documents = new Map<string, unknown>();
  const kv = new Map<string, unknown>();
  let waitIndexingCalls = 0;

  const index = {
    query: (options: { filter: Record<string, unknown>; limit: number }) => {
      queries.push(options);
      return Promise.resolve(rows);
    },
    waitIndexing: () => {
      waitIndexingCalls += 1;
      return Promise.resolve();
    },
  };

  const redis = {
    search: {
      index: (options: { name?: string }) => {
        indexOptions.push(options);
        return index;
      },
      createIndex: () => Promise.resolve(),
    },
    json: {
      set: (key: string, _path: string, value: unknown) => {
        documents.set(key, value);
        return Promise.resolve("OK");
      },
    },
    get: (key: string) => Promise.resolve(kv.get(key) ?? null),
    set: (key: string, value: unknown) => {
      kv.set(key, value);
      return Promise.resolve("OK");
    },
    del: (key: string) => Promise.resolve(documents.delete(key) ? 1 : 0),
  };

  return {
    redis: redis as never,
    indexOptions,
    queries,
    documents,
    kv,
    setRows: (next: ScriptedRow[]) => {
      rows = next;
    },
    waitIndexingCalls: () => waitIndexingCalls,
  };
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

  it("autoCapture can be turned off; recall and the tools stay either way", () => {
    // Registering no capture handler is what makes `false` genuinely inert. `tools` is not
    // configurable — a slot with no way to save or forget would be a strange thing to declare.
    const provider = redisMemory({ redis: offlineRedis, autoCapture: false });
    expect(provider.capture).toBeUndefined();
    expect(typeof provider.recall["turn.started"]).toBe("function");
    expect(typeof provider.tools).toBe("function");
  });

  it("default capture reads only user-authored text of the settled turn", async () => {
    const add = vi
      .spyOn(AgentMemory.prototype, "add")
      .mockResolvedValue({ id: "x", text: "x", createdAt: 0 });
    await captureAt(
      redisMemory({ redis: scriptedRedis().redis }),
      "turn.completed",
      operationContext({
        scopeKey: "scope",
        input: [
          userMessage("  I  prefer   dark mode "),
          { role: "assistant", content: [{ type: "text", text: "Noted." }] },
          { role: "user", content: "and I live in Berlin" },
          userMessage("   "),
        ],
      }),
    );
    // Assistant output is never captured; whitespace is normalized; blanks are dropped.
    expect(add.mock.calls.map((call) => (call[0] as { text: string }).text)).toEqual([
      "I prefer dark mode",
      "and I live in Berlin",
    ]);
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

  it("default capture stores nothing when a compaction has no active turn", async () => {
    const add = vi
      .spyOn(AgentMemory.prototype, "add")
      .mockResolvedValue({ id: "x", text: "x", createdAt: 0 });
    // `compaction.requested` can arrive with `turn: null` (standalone compaction).
    await captureAt(redisMemory({ redis: scriptedRedis().redis }), "compaction.requested", {
      ...operationContext({ scopeKey: "scope" }),
      turn: null,
    } as never);
    expect(add).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------------------------------------
// redisMemory() — recall/capture actually firing, and what they ask Redis for
//
// The live suite below proves the round trip end to end, but it cannot prove *which* calls
// happened: a provider that recalled from an in-process cache, queried the wrong index, or never
// wired `compaction.completed` at all could still satisfy it. These do that part deterministically
// — no network, no BM25, no indexing lag.
// -------------------------------------------------------------------------------------------

describe("redisMemory() — recall and capture invocation (offline)", () => {
  // eve hands over an opaque, colon-bearing scope digest; AgentMemory rejects ':' in a userId.
  const SCOPE = "memscope1:AbC-123";
  const USER_ID = "memscope1_AbC-123";
  const memoryKey = (id: string) => "agentkit:memory:" + USER_ID + ":" + id;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recall['turn.started'] calls AgentMemory.recall with the locked scope, topK and the turn's text", async () => {
    const recall = vi.spyOn(AgentMemory.prototype, "recall").mockResolvedValue([]);
    const provider = redisMemory({
      redis: scriptedRedis().redis,
      topK: 3,
      minScore: 0.25,
      replayCacheTtlSeconds: 0,
    });

    await recallAt(
      provider,
      "turn.started",
      operationContext({ scopeKey: SCOPE, input: [userMessage("what theme do I like?")] }),
    );

    // The point of the test: the handler delegates to AgentMemory — once — with the scope eve
    // locked (sanitized), the configured ranking knobs, and the caller's own words as the query.
    expect(recall).toHaveBeenCalledTimes(1);
    expect(recall).toHaveBeenCalledWith({
      userId: USER_ID,
      topK: 3,
      query: "what theme do I like?",
      minScore: 0.25,
    });
  });

  it("recall['compaction.completed'] runs the same recall against the same locked scope", async () => {
    const recall = vi.spyOn(AgentMemory.prototype, "recall").mockResolvedValue([]);
    const provider = redisMemory({
      redis: scriptedRedis().redis,
      topK: 3,
      minScore: 0.25,
      replayCacheTtlSeconds: 0,
    });

    // eve only reaches this hook after a compaction checkpoint, so nothing else in the suite would
    // notice if it were registered but broken.
    const content = await recallAt(
      provider,
      "compaction.completed",
      operationContext({ scopeKey: SCOPE, input: [userMessage("what theme do I like?")] }),
    );

    expect(recall).toHaveBeenCalledTimes(1);
    expect(recall).toHaveBeenCalledWith({
      userId: USER_ID,
      topK: 3,
      query: "what theme do I like?",
      minScore: 0.25,
    });
    expect(content).toContain("# Recalled memories for recall");
  });

  it("recall reaches Redis as a userId-scoped $smart query on the shared agentkit:memory index", async () => {
    // No spy this time — the real AgentMemory runs, so this asserts the query that would actually
    // hit Upstash Redis Search. One row, so the $smart query "matches" and AgentMemory does not
    // fall back to its unfiltered second query (covered separately below).
    const script = scriptedRedis([
      { key: memoryKey("aaaaaaaaaaaa"), score: 2, data: { text: "dark mode", createdAt: 1 } },
    ]);
    const provider = redisMemory({ redis: script.redis, topK: 4, replayCacheTtlSeconds: 0 });

    await recallAt(
      provider,
      "turn.started",
      operationContext({ scopeKey: SCOPE, input: [userMessage("what theme do I like?")] }),
    );

    // The default prefix means memory slots share the memory tools' index instead of minting one
    // (an Upstash database caps at 10 search indexes).
    expect(script.indexOptions[0]?.name).toBe("agentkit_memory");
    expect(script.queries).toHaveLength(1);
    expect(script.queries[0]).toEqual({
      filter: { userId: { $eq: USER_ID }, text: { $smart: "what theme do I like?" } },
      limit: 4,
    });
  });

  it("recall renders the rows the index returned into the model-facing block", async () => {
    const script = scriptedRedis([
      {
        key: memoryKey("aaaaaaaaaaaa"),
        score: 3.5,
        data: { text: "The user prefers dark mode", createdAt: 1 },
      },
      {
        key: memoryKey("bbbbbbbbbbbb"),
        score: 1.2,
        data: { text: "The user lives in Berlin", createdAt: 2 },
      },
    ]);
    const provider = redisMemory({ redis: script.redis, replayCacheTtlSeconds: 0 });

    const content = await recallAt(
      provider,
      "turn.started",
      operationContext({ scopeKey: SCOPE, slot: "profile", input: [userMessage("tell me")] }),
    );

    // What the index returned is what the model sees, id-first so forget_memory can address it.
    expect(content).toContain("aaaaaaaaaaaa: The user prefers dark mode");
    expect(content).toContain("bbbbbbbbbbbb: The user lives in Berlin");
    expect(content).toContain("profile__forget_memory");
  });

  it("a replayed operationId is served from the cache without re-querying the index", async () => {
    const script = scriptedRedis([
      {
        key: memoryKey("aaaaaaaaaaaa"),
        score: 3.5,
        data: { text: "The user prefers dark mode", createdAt: 1 },
      },
    ]);
    const provider = redisMemory({ redis: script.redis, autoCapture: true });
    const context = operationContext({
      scopeKey: SCOPE,
      operationId: "op-replay-1",
      input: [userMessage("tell me")],
    });

    const first = await recallAt(provider, "turn.started", context);
    expect(script.queries).toHaveLength(1);

    // The store changes underneath, exactly as it can between a run and its durable replay.
    script.setRows([
      { key: memoryKey("cccccccccccc"), score: 9, data: { text: "Something new", createdAt: 3 } },
    ]);

    const replay = await recallAt(provider, "turn.started", context);
    // Byte-identical AND no second query — eve throws if a replayed operationId returns anything
    // else, so the cache has to short-circuit the search itself, not just the formatting.
    expect(replay).toBe(first);
    expect(script.queries).toHaveLength(1);

    // A different operation does query again, and sees the new state.
    const fresh = await recallAt(
      provider,
      "turn.started",
      operationContext({ scopeKey: SCOPE, input: [userMessage("tell me")] }),
    );
    expect(script.queries).toHaveLength(2);
    expect(fresh).toContain("Something new");
  });

  it("recall falls back to the scope's memories when the text matches nothing", async () => {
    const script = scriptedRedis([]); // the $smart query matches nothing
    const provider = redisMemory({ redis: script.redis, replayCacheTtlSeconds: 0 });

    await recallAt(
      provider,
      "turn.started",
      operationContext({ scopeKey: SCOPE, input: [userMessage("zzzz")] }),
    );

    // AgentMemory retries filter-only, so a turn whose words match nothing still recalls the scope.
    expect(script.queries).toHaveLength(2);
    expect(script.queries[0]?.filter).toHaveProperty("text");
    expect(script.queries[1]?.filter).toEqual({ userId: { $eq: USER_ID } });
  });

  it("capture['turn.completed'] adds every user message through AgentMemory.add, then waits for indexing", async () => {
    const add = vi
      .spyOn(AgentMemory.prototype, "add")
      .mockResolvedValue({ id: "x", text: "x", createdAt: 0 });
    const script = scriptedRedis();
    const provider = redisMemory({ redis: script.redis, autoCapture: true });

    await captureAt(
      provider,
      "turn.completed",
      operationContext({
        scopeKey: SCOPE,
        input: [
          userMessage("I prefer dark mode"),
          { role: "assistant", content: "Noted." },
          userMessage("I live in Berlin"),
        ],
      }),
    );

    expect(add).toHaveBeenCalledTimes(2); // the assistant turn is never captured
    expect(add).toHaveBeenNthCalledWith(1, {
      text: "I prefer dark mode",
      userId: USER_ID,
      id: expect.stringMatching(/^[0-9a-f]{12}$/),
      // `conversations` is off here, so the metadata is the source alone.
      metadata: { source: "userMessage" },
    });
    expect(add).toHaveBeenNthCalledWith(2, {
      text: "I live in Berlin",
      userId: USER_ID,
      id: expect.stringMatching(/^[0-9a-f]{12}$/),
      metadata: { source: "userMessage" },
    });
    // Without this the memory stays invisible to the next turn's recall for far longer than a turn.
    expect(script.waitIndexingCalls()).toBe(1);
  });

  it("capture['compaction.requested'] captures through the same path", async () => {
    const add = vi
      .spyOn(AgentMemory.prototype, "add")
      .mockResolvedValue({ id: "x", text: "x", createdAt: 0 });
    const provider = redisMemory({ redis: scriptedRedis().redis, autoCapture: true });

    await captureAt(
      provider,
      "compaction.requested",
      operationContext({ scopeKey: SCOPE, input: [userMessage("I ride a Brompton")] }),
    );

    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith({
      text: "I ride a Brompton",
      userId: USER_ID,
      id: expect.stringMatching(/^[0-9a-f]{12}$/),
      metadata: { source: "userMessage" },
    });
  });

  it("writes reach Redis as one JSON document per memory under the scope's key prefix", async () => {
    // The real AgentMemory again: this is the exact `json.set` a live capture performs.
    const script = scriptedRedis();
    const provider = redisMemory({ redis: script.redis, autoCapture: true });

    await captureAt(
      provider,
      "turn.completed",
      operationContext({ scopeKey: SCOPE, input: [userMessage("I prefer dark mode")] }),
    );

    const keys = [...script.documents.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp("^agentkit:memory:" + USER_ID + ":[0-9a-f]{12}$"));
    expect([...script.documents.values()][0]).toEqual({
      text: "I prefer dark mode",
      userId: USER_ID,
      createdAt: expect.any(Number),
      metadata: { source: "userMessage" },
    });
  });

  it("stamps a source on every write, and a deliberate save is a third one", async () => {
    const add = vi
      .spyOn(AgentMemory.prototype, "add")
      .mockResolvedValue({ id: "x", text: "x", createdAt: 0 });
    const context = operationContext({
      scopeKey: SCOPE,
      input: [userMessage("I ride a Brompton")],
      messages: [userMessage("I ride a Brompton"), { role: "assistant", content: "Noted." }],
    });

    // "all" captures both halves of the turn, and they are tagged differently.
    await captureAt(
      redisMemory({ redis: scriptedRedis().redis, autoCapture: "all" }),
      "turn.completed",
      context,
    );
    expect(add.mock.calls.map((c) => (c[0] as { metadata: unknown }).metadata)).toEqual([
      { source: "userMessage" },
      { source: "agentMessage" },
    ]);

    // A save_memory call is the third source, so the model can weigh it differently on recall.
    add.mockClear();
    const tools = await redisMemory({ redis: scriptedRedis().redis }).tools!({
      ...context,
      turn: { id: "t", input: [], sequence: 1 },
    } as never);
    await callTool(tools, "save_memory", { text: "The user commutes by bike" });
    expect((add.mock.calls[0]![0] as { metadata: unknown }).metadata).toEqual({ source: "agent" });
  });

  it("recall labels each line with its source, and omits it for pre-metadata records", async () => {
    const row = (id: string, text: string, score: number, metadata?: Record<string, unknown>) => ({
      key: `agentkit:memory:${USER_ID}:${id}`,
      score,
      data: { text, createdAt: 0, ...(metadata ? { metadata } : {}) },
    });
    const script = scriptedRedis([
      row("aaaaaaaaaaaa", "saved fact", 9, { source: "agent" }),
      row("bbbbbbbbbbbb", "user said", 8, { source: "userMessage" }),
      row("cccccccccccc", "model said", 7, { source: "agentMessage" }),
      row("dddddddddddd", "legacy row", 6), // written before `metadata` existed
    ]);

    const content = await recallContent(
      redisMemory({ redis: script.redis, replayCacheTtlSeconds: 0 }),
      operationContext({ scopeKey: SCOPE, input: [userMessage("what do you know?")] }),
    );

    expect(content).toContain("aaaaaaaaaaaa: saved fact (you saved this)");
    expect(content).toContain("bbbbbbbbbbbb: user said (the user said this)");
    expect(content).toContain("cccccccccccc: model said (you said this)");
    // No metadata → no note, rather than a guessed one.
    expect(content).toMatch(/^dddddddddddd: legacy row$/m);
  });

  it("autoCapture selects what gets stored: fromUser / fromModel / all", async () => {
    const add = vi
      .spyOn(AgentMemory.prototype, "add")
      .mockResolvedValue({ id: "x", text: "x", createdAt: 0 });
    // A settled turn: the user asked, the model answered. `latestModelTexts` anchors on the last
    // user message, so only *this* turn's reply is eligible — not every assistant message ever.
    const context = () =>
      operationContext({
        scopeKey: SCOPE,
        input: [userMessage("I ride a Brompton")],
        messages: [userMessage("I ride a Brompton"), { role: "assistant", content: "Noted." }],
      });
    const captured = async (autoCapture: RedisMemoryConfig["autoCapture"]) => {
      add.mockClear();
      await captureAt(
        redisMemory({ redis: scriptedRedis().redis, autoCapture }),
        "turn.completed",
        context(),
      );
      return add.mock.calls.map((call) => (call[0] as { text: string }).text);
    };

    expect(await captured("fromUser")).toEqual(["I ride a Brompton"]);
    expect(await captured(true)).toEqual(["I ride a Brompton"]); // `true` === "fromUser"
    expect(await captured("fromModel")).toEqual(["Noted."]);
    expect(await captured("all")).toEqual(["I ride a Brompton", "Noted."]);
    expect(await captured(undefined)).toEqual(["I ride a Brompton"]); // the default
  });

  it("conversations: off by default, and contributes read_conversation when on", async () => {
    const plain = redisMemory({ redis: offlineRedis });
    const withConversations = redisMemory({ redis: offlineRedis, conversations: true });
    const context = {
      ...operationContext({ scopeKey: SCOPE }),
      turn: { id: "t", input: [], sequence: 1 },
    };

    expect(Object.keys((await plain.tools!(context as never))!).sort()).toEqual([
      "forget_memory",
      "save_memory",
    ]);
    expect(Object.keys((await withConversations.tools!(context as never))!).sort()).toEqual([
      "forget_memory",
      "read_conversation",
      "save_memory",
    ]);

    // Transcripts need `turn.completed`, so the handler is registered even with autoCapture off.
    expect(typeof withConversations.capture?.["turn.completed"]).toBe("function");
    expect(
      redisMemory({ redis: offlineRedis, autoCapture: false, conversations: true }).capture?.[
        "turn.completed"
      ],
    ).toBeTypeOf("function");
    // ...and with neither, there is nothing to capture at all.
    expect(redisMemory({ redis: offlineRedis, autoCapture: false }).capture).toBeUndefined();
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

// -------------------------------------------------------------------------------------------
// 2. MemoryProvider over AgentMemory (live Redis)
// -------------------------------------------------------------------------------------------

describe.skipIf(!hasRedisCreds)("redisMemory() — MemoryProvider (live Redis)", () => {
  const redis = testRedis();
  // Reuse the default `agentkit:memory` prefix (and therefore its shared search index) — an Upstash
  // database caps at 10 indexes, so a memory slot must not mint its own. Isolation is by scope key.
  const scopes: string[] = [];
  /** A fresh, collision-proof scope key, registered for cleanup. */
  const newScope = (label: string): string => {
    const scope = uniqueUserId(`eve-slot-${label}`);
    scopes.push(scope);
    return scope;
  };
  const scopeKey = newScope("shared");
  /** Scopes that also wrote a transcript, so the chat keys get cleaned up too. */
  const chatScopes: string[] = [];
  const provider = redisMemory({ redis, topK: 5, autoCapture: true });
  // A throwaway handle on the same default index, to provision it and wait for indexing.
  const index = new AgentMemory({ redis }).searchIndex;

  beforeAll(async () => {
    // Provision BEFORE any write: a doc written while the index is still missing can be dropped by
    // the create-time backfill permanently, not just late.
    await index.query({ filter: { userId: { $eq: "nobody" } }, limit: 1 } as never);
  });

  afterAll(async () => {
    for (const scope of scopes) {
      await cleanupKeys(redis, `agentkit:memory:${scope}`);
      await cleanupKeys(redis, `agentkit:memoryRecall:${scope}`);
    }
    for (const scope of chatScopes) {
      await cleanupKeys(redis, `agentkit:chat:${scope}`);
    }
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
    // Each line is `<id>: <text> (<notes>)` so the model can call forget_memory with the id and
    // knows the memory was captured rather than deliberately saved.
    expect(content).toMatch(
      /^[0-9a-f]{12}: I prefer dark mode in every editor \(the user said this\)$/m,
    );
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
    const isolated = newScope("assistant");
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
    const isolated = newScope("long");
    const small = redisMemory({ redis, maxMemoryCharacters: 20, autoCapture: true });
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
    // `exists` straight after the `del` is a raw read that can be answered by a replica that hasn't
    // caught up yet (see `RedisMemoryDocumentBackend.read` for the mechanism) — poll it.
    expect(
      await pollUntil(
        () => redis.exists(`agentkit:memory:${scopeKey}:${saved.id}`),
        (value) => value === 0,
      ),
    ).toBe(0);
  });

  // ---------------------------------------------------------------------------------------
  // Persistence: what capture wrote is really in Redis, and recall gets it back
  // ---------------------------------------------------------------------------------------

  it("capture persists one JSON document per memory to Redis", async () => {
    const scope = newScope("persist");
    await captureAt(
      provider,
      "turn.completed",
      operationContext({
        scopeKey: scope,
        input: [
          userMessage("My cat is called Ada"),
          { role: "assistant", content: "Lovely name." },
          userMessage("I commute on a Brompton"),
        ],
      }),
    );

    // Assert against real Redis, not against "no error was thrown": both memories exist, at the
    // content-addressed keys the provider derives, with the exact stored document shape.
    const expected = new Map(
      ["My cat is called Ada", "I commute on a Brompton"].map((text) => [
        `agentkit:memory:${scope}:${stableHash(text).slice(0, 12)}`,
        text,
      ]),
    );
    const keys = await redis.keys(`agentkit:memory:${scope}:*`);
    expect(keys.sort()).toEqual([...expected.keys()].sort());

    for (const [key, text] of expected) {
      expect(await redis.json.get(key)).toEqual({
        text,
        userId: scope,
        createdAt: expect.any(Number),
        metadata: { source: "userMessage" },
      });
    }
    // The assistant message was never written.
    expect(keys).toHaveLength(2);
  });

  it("round-trips: recall returns exactly the memories Redis is holding", async () => {
    const scope = newScope("roundtrip");
    const text = "I always deploy on Fridays";
    await captureAt(
      provider,
      "turn.completed",
      operationContext({ scopeKey: scope, input: [userMessage(text)] }),
    );

    // Take the id and text from REDIS, so the recall assertion below is tied to persisted state
    // rather than to a value hardcoded in the test.
    const [key] = await redis.keys(`agentkit:memory:${scope}:*`);
    expect(key).toBeDefined();
    const stored = (await redis.json.get(key!)) as { text: string };
    const id = key!.slice(`agentkit:memory:${scope}:`.length);

    await index.waitIndexing();
    const content = await pollUntil(
      () =>
        recallAt(
          provider,
          "turn.started",
          operationContext({ scopeKey: scope, input: [userMessage("when do I ship?")] }),
        ),
      (c) => c.includes(stored.text),
    );
    // `<id>: <text>` — the id the model would hand back to forget_memory is the Redis key part.
    expect(content).toContain(`${id}: ${stored.text}`);
  });

  it("round-trips through the compaction hooks too (capture on requested, recall on completed)", async () => {
    const scope = newScope("compaction");
    const text = "My deploy target is Vercel";

    // eve calls this one before a compaction checkpoint; nothing else in the suite reaches it.
    await captureAt(
      provider,
      "compaction.requested",
      operationContext({ scopeKey: scope, input: [userMessage(text)] }),
    );

    const key = `agentkit:memory:${scope}:${stableHash(text).slice(0, 12)}`;
    expect(await redis.json.get(key)).toEqual({
      text,
      userId: scope,
      createdAt: expect.any(Number),
      metadata: { source: "userMessage" },
    });

    await index.waitIndexing();
    // ...and this one after it. Both halves of the compaction lifecycle, against real Redis.
    const content = await pollUntil(
      () =>
        recallAt(
          provider,
          "compaction.completed",
          operationContext({ scopeKey: scope, input: [userMessage("where do I deploy?")] }),
        ),
      (c) => c.includes(text),
    );
    expect(content).toContain("# Recalled memories for recall");
    expect(content).toContain(text);
  });

  it("rejects a model-supplied memory id that could address another scope's key", async () => {
    const tools = await provider.tools!(operationContext({ scopeKey }) as never);
    await expect(callTool(tools, "forget_memory", { id: "../../other:key" })).rejects.toThrow(
      /not a valid memory id/,
    );
  });

  it("conversations: stamps conversationId, stores the transcript, and reads it back", async () => {
    const isolated = newScope("conv");
    // Default `agentkit:chat` prefix on purpose: a per-test prefix would mint a new search index,
    // and an Upstash database caps at 10.
    const withConversations = redisMemory({ redis, autoCapture: true, conversations: true });
    const sessionId = "conv-session-1";
    const context = operationContext({
      scopeKey: isolated,
      sessionId,
      input: [userMessage("I ride a Brompton")],
      messages: [
        userMessage("I ride a Brompton"),
        { role: "assistant", content: "Nice — folding bikes are great on trains." },
      ],
    });
    chatScopes.push(isolated);

    await captureTurn(withConversations, context);

    // The memory carries the pointer and its source, stored unindexed alongside `createdAt`.
    const keys = await redis.keys(`agentkit:memory:${isolated}:*`);
    expect(keys).toHaveLength(1);
    const doc = await redis.json.get<Record<string, unknown>[]>(keys[0]!, "$");
    expect(doc![0]!.metadata).toEqual({ source: "userMessage", conversationId: sessionId });

    // Recall advertises the pointer so the model knows read_conversation is worth calling.
    const content = await recallContent(withConversations, context);
    expect(content).toContain(`conversation=${sessionId}`);
    expect(content).toContain("read_conversation");

    // And the tool expands it into the full exchange — including the model's reply, which is the
    // whole point: the memory matched the question, the answer is what the caller wanted.
    const tools = await withConversations.tools!({
      ...context,
      turn: { id: "t", input: [], sequence: 1 },
    } as never);
    const read = await callTool<{
      found: boolean;
      truncated: boolean;
      messages: { role: string; content: string }[];
    }>(tools, "read_conversation", { conversationId: sessionId });
    expect(read.found).toBe(true);
    expect(read.truncated).toBe(false);
    expect(read.messages).toEqual([
      { role: "user", content: "I ride a Brompton" },
      { role: "assistant", content: "Nice — folding bikes are great on trains." },
    ]);
  });

  it("conversations: the recalled block is never written into the transcript it points at", async () => {
    const isolated = newScope("convclean");
    const withConversations = redisMemory({ redis, autoCapture: true, conversations: true });
    const sessionId = "conv-session-2";
    chatScopes.push(isolated);
    // A projected history that already contains an injected recall block, as eve hands it to us.
    await captureTurn(
      withConversations,
      operationContext({
        scopeKey: isolated,
        sessionId,
        input: [userMessage("what do you know?")],
        messages: [
          { role: "user", content: "# Recalled memories for recall\n\nabc123: I ride a Brompton" },
          userMessage("what do you know?"),
          { role: "assistant", content: "You ride a Brompton." },
        ],
      }),
    );

    const chat = await redis.json.get<Record<string, unknown>[]>(
      `agentkit:chat:${isolated}:${sessionId}`,
      "$",
    );
    const messages = chat![0]!.messages as { content: string }[];
    // Storing it would round-trip recall output back into the transcript recall later expands.
    expect(messages.some((m) => m.content.startsWith("# Recalled memories for"))).toBe(false);
    expect(messages).toHaveLength(2);
  });
});
