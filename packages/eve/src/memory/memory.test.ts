import { AgentMemory, stableHash } from "@upstash/agentkit-sdk";
import { s } from "@upstash/redis";
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
    // eve's real contexts extend SessionContext; `rememberSessions` is the only feature that reads it.
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
  const counts: { filter: Record<string, unknown> }[] = [];
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
    count: (options: { filter: Record<string, unknown> }) => {
      counts.push(options);
      return Promise.resolve({ count: rows.length });
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
    counts,
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
    // No `compaction.requested` — messages are stored as they happen, so nothing is lost to the
    // summarizer, and it was the only context where the ordering `sequence` could be null.
    expect(provider.capture?.["compaction.requested"]).toBeUndefined();
    expect(typeof provider.tools).toBe("function");
  });

  it("rememberMessages can be turned off; recall and the tools stay either way", () => {
    // Nothing left to capture, so no handler is registered at all — that is what makes `false`
    // genuinely inert. `tools` is not configurable: a slot with no way to save, search, forget or
    // read back would be a strange thing to declare.
    const provider = redisMemory({ redis: offlineRedis, rememberMessages: false });
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

  // The backend used to confirm an "absent" answer for a key it had written, working around
  // `@upstash/redis` sending its read-your-writes `upstash-sync-token` one request late (fixed in
  // 1.38.4, which is now the floor). Without that workaround a read is a single `HMGET` again.
  it("reads an absent document in a single round trip", async () => {
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
    // e.g. `ttlSeconds` expired it, or the scope is new: `null` is the answer, first time of asking.
    expect(await backend.read({ key: "gone", signal })).toBeNull();
    expect(hmgets).toBe(1);
    expect(await backend.read({ key: "gone", signal })).toBeNull();
    expect(hmgets).toBe(2);
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
  const memoryKey = (id: string) => "agentkit:memorySlot:" + USER_ID + ":" + id;

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
      filter: { source: { $eq: "agent" }, deleted: { $eq: false } },
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
      filter: { source: { $eq: "agent" }, deleted: { $eq: false } },
    });
    expect(content).toContain("# Recalled memories for recall");
  });

  it("recall reaches Redis as a userId-scoped $smart query on the shared agentkit:memory index", async () => {
    // No spy this time — the real AgentMemory runs, so this asserts the query that would actually
    // hit Upstash Redis Search.
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
    expect(script.indexOptions[0]?.name).toBe("agentkit_memorySlot");
    expect(script.queries).toHaveLength(1);
    // Narrowed to curated facts and to live records: captured turns share this index but must not
    // compete for the same `topK`, and a redacted entry must never come back.
    expect(script.queries[0]).toEqual({
      filter: {
        userId: { $eq: USER_ID },
        text: { $smart: "what theme do I like?" },
        source: { $eq: "agent" },
        deleted: { $eq: false },
      },
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
    const provider = redisMemory({ redis: script.redis, rememberMessages: true });
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

  it("recall queries once and reports a miss when the text matches nothing", async () => {
    const script = scriptedRedis([]); // the $smart query matches nothing
    const provider = redisMemory({ redis: script.redis, replayCacheTtlSeconds: 0 });

    const content = await recallAt(
      provider,
      "turn.started",
      operationContext({ scopeKey: SCOPE, input: [userMessage("zzzz")] }),
    );

    // One query, and no unfiltered second one: `AgentMemory` has no "everything for the user"
    // fallback, so a miss stays a miss instead of surfacing unrelated memories as if they matched.
    expect(script.queries).toHaveLength(1);
    expect(script.queries[0]?.filter).toHaveProperty("text");
    // The block has to say "nothing matched", not "nothing is stored" — the store may be full.
    expect(content).toContain("Nothing you have saved matched this turn");
    expect(content).toContain("search_memory");
  });

  it("capture['turn.completed'] adds every user message through AgentMemory.add, then waits for indexing", async () => {
    const add = vi
      .spyOn(AgentMemory.prototype, "add")
      .mockResolvedValue({ id: "x", text: "x", createdAt: 0 });
    const script = scriptedRedis();
    const provider = redisMemory({ redis: script.redis, rememberMessages: true });

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
    // Flat, indexed fields — and a `subIndex` that counts per source, so the two halves of a turn
    // each start at zero and still sort correctly against each other.
    expect(add).toHaveBeenNthCalledWith(1, {
      text: "I prefer dark mode",
      userId: USER_ID,
      id: expect.stringMatching(/^[0-9a-f]{12}$/),
      metadata: {
        sessionId: "session-1",
        source: "userMessage",
        deleted: false,
        sequence: 1,
        subIndex: 0,
      },
    });
    expect(add).toHaveBeenNthCalledWith(2, {
      text: "I live in Berlin",
      userId: USER_ID,
      id: expect.stringMatching(/^[0-9a-f]{12}$/),
      metadata: {
        sessionId: "session-1",
        source: "userMessage",
        deleted: false,
        sequence: 1,
        subIndex: 1,
      },
    });
    // Without this the memory stays invisible to the next turn's recall for far longer than a turn.
    expect(script.waitIndexingCalls()).toBe(1);
  });

  it("writes reach Redis as one JSON document per memory under the scope's key prefix", async () => {
    // The real AgentMemory again: this is the exact `json.set` a live capture performs.
    const script = scriptedRedis();
    const provider = redisMemory({ redis: script.redis, rememberMessages: true });

    await captureAt(
      provider,
      "turn.completed",
      operationContext({ scopeKey: SCOPE, input: [userMessage("I prefer dark mode")] }),
    );

    const keys = [...script.documents.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp("^agentkit:memorySlot:" + USER_ID + ":[0-9a-f]{12}$"));
    expect([...script.documents.values()][0]).toEqual({
      text: "I prefer dark mode",
      userId: USER_ID,
      createdAt: expect.any(Number),
      sessionId: "session-1",
      source: "userMessage",
      deleted: false,
      sequence: 1,
      subIndex: 0,
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
      redisMemory({ redis: scriptedRedis().redis, rememberMessages: "all" }),
      "turn.completed",
      context,
    );
    expect(
      add.mock.calls.map((c) => {
        const a = c[0] as { metadata?: { source?: string; sessionId?: string } };
        return { source: a.metadata?.source, sessionId: a.metadata?.sessionId };
      }),
    ).toEqual([
      { source: "userMessage", sessionId: "session-1" },
      { source: "agentMessage", sessionId: "session-1" },
    ]);

    // A save_memory call is the third source, so the model can weigh it differently on recall.
    add.mockClear();
    const tools = await redisMemory({ redis: scriptedRedis().redis }).tools!({
      ...context,
      turn: { id: "t", input: [], sequence: 1 },
    } as never);
    await callTool(tools, "save_memory", { text: "The user commutes by bike" });
    const saved = add.mock.calls[0]![0] as { metadata?: { source?: string; sessionId?: string } };
    expect(saved.metadata?.source).toBe("agent");
    expect(saved.metadata?.sessionId).toBe("session-1");
  });

  it("recall renders only curated facts, tagged with the session they were saved in", async () => {
    const row = (id: string, text: string, score: number, extra: Record<string, unknown>) => ({
      key: `agentkit:memorySlot:${USER_ID}:${id}`,
      score,
      data: { text, createdAt: 0, ...extra },
    });
    // The index only ever returns agent rows for this query (the filter is asserted elsewhere), so
    // this pins what the block does with them.
    const script = scriptedRedis([
      row("aaaaaaaaaaaa", "saved fact", 9, { source: "agent", sessionId: "sess-9" }),
      row("bbbbbbbbbbbb", "older fact", 8, { source: "agent" }),
    ]);

    const content = await recallContent(
      redisMemory({ redis: script.redis, replayCacheTtlSeconds: 0 }),
      operationContext({ scopeKey: SCOPE, input: [userMessage("what do you know?")] }),
    );

    expect(content).toContain("aaaaaaaaaaaa: saved fact (session=sess-9)");
    // No session recorded → no tag, rather than a guessed one.
    expect(content).toMatch(/^bbbbbbbbbbbb: older fact$/m);
    expect(content).toContain("recall__read_session");
  });

  it("rememberMessages selects what gets stored: fromUser / fromModel / all", async () => {
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
    const captured = async (rememberMessages: RedisMemoryConfig["rememberMessages"]) => {
      add.mockClear();
      await captureAt(
        redisMemory({ redis: scriptedRedis().redis, rememberMessages }),
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

  it("drops forget_memory in the modes that store the assistant's replies", async () => {
    const context = {
      ...operationContext({ scopeKey: SCOPE }),
      turn: { id: "t", input: [], sequence: 1 },
    };
    // Capturing the assistant's replies makes deletion undeliverable: confirming an erasure records
    // the erased text, so a tool reporting success would be lying. Measured — after one forget, the
    // phrase survived in three records, all of them assistant replies about the deletion.
    for (const rememberMessages of ["all", "fromModel"] as const) {
      const keys = Object.keys(
        (await redisMemory({ redis: offlineRedis, rememberMessages }).tools!(context as never))!,
      ).sort();
      expect(keys).toEqual(["read_session", "save_memory", "search_memory"]);
    }
    // The modes that do not store replies keep it.
    for (const rememberMessages of [undefined, true, "fromUser", false] as const) {
      const keys = Object.keys(
        (await redisMemory({
          redis: offlineRedis,
          ...(rememberMessages !== undefined ? { rememberMessages } : {}),
        }).tools!(context as never))!,
      ).sort();
      expect(keys).toContain("forget_memory");
    }
  });

  it("always contributes all four tools, and captures only when rememberMessages is on", async () => {
    const context = {
      ...operationContext({ scopeKey: SCOPE }),
      turn: { id: "t", input: [], sequence: 1 },
    };

    // `read_session` is unconditional now — a session is whatever was stored from it, so there is
    // no separate storage decision to gate the reader on.
    for (const provider of [
      redisMemory({ redis: offlineRedis }),
      redisMemory({ redis: offlineRedis, rememberMessages: false }),
    ]) {
      expect(Object.keys((await provider.tools!(context as never))!).sort()).toEqual([
        "forget_memory",
        "read_session",
        "save_memory",
        "search_memory",
      ]);
    }

    // Capture exists only when there are messages to capture — nothing else writes at turn end.
    expect(typeof redisMemory({ redis: offlineRedis }).capture?.["turn.completed"]).toBe(
      "function",
    );
    expect(redisMemory({ redis: offlineRedis, rememberMessages: false }).capture).toBeUndefined();
    // `compaction.requested` is gone: messages are stored as they happen, so nothing is lost to
    // the summarizer, and it was the only context where `turn` could be null.
    expect(redisMemory({ redis: offlineRedis }).capture?.["compaction.requested"]).toBeUndefined();
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
    // Polled as cheap insurance: this is a live database, and `ttl` is a raw metadata read issued
    // straight after the write.
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
  const provider = redisMemory({ redis, topK: 5, rememberMessages: true });
  // A throwaway handle on the slot's own index — the provider no longer shares `agentkit:memory`
  // with the standalone memory tools, because a schema with extra required fields must not cover a
  // keyspace that already holds records written without them.
  const index = new AgentMemory({
    redis,
    prefix: "agentkit:memorySlot",
    metadataSchema: {
      sessionId: s.string().noTokenize(),
      source: s.string().noTokenize(),
      deleted: s.boolean(),
      sequence: s.number(),
      subIndex: s.number(),
    },
  }).searchIndex;

  beforeAll(async () => {
    // Provision BEFORE any write: a doc written while the index is still missing can be dropped by
    // the create-time backfill permanently, not just late.
    await index.query({ filter: { userId: { $eq: "nobody" } }, limit: 1 } as never);
  });

  afterAll(async () => {
    for (const scope of scopes) {
      await cleanupKeys(redis, `agentkit:memorySlot:${scope}`);
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
    expect(content).toContain("Nothing you have saved matched this turn");
  });

  it("captures the turn's text but keeps it out of the recalled block", async () => {
    await captureTurn(
      provider,
      operationContext({
        scopeKey,
        input: [userMessage("I prefer dark mode in every editor")],
      }),
    );
    await index.waitIndexing();

    // Captured turns are stored, and searchable...
    const tools = await provider.tools!(operationContext({ scopeKey, slot: "recall" }) as never);
    const found = await pollUntil(
      () =>
        callTool<{ memories: { text: string; source?: string }[] }>(tools, "search_memory", {
          query: "dark mode editor",
        }),
      (r) => r.memories.some((m) => m.text.includes("dark mode")),
    );
    expect(found.memories.some((m) => m.source === "userMessage")).toBe(true);

    // ...but recall injects curated facts only, so a captured turn can never crowd one out.
    const content = await recallContent(
      provider,
      operationContext({ scopeKey, input: [userMessage("what theme do I like?")] }),
    );
    expect(content).not.toContain("dark mode");
    // Instead it says how much is reachable, so the model has a reason to go looking.
    expect(content).toMatch(/stored messages? from earlier conversations/);
    expect(content).toContain("recall__search_memory");
  });

  it("is idempotent: capturing the same text twice stores one memory", async () => {
    const before = await redis.keys(`agentkit:memorySlot:${scopeKey}:*`);
    await captureTurn(
      provider,
      operationContext({ scopeKey, input: [userMessage("I prefer dark mode in every editor")] }),
    );
    const after = await redis.keys(`agentkit:memorySlot:${scopeKey}:*`);
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
    expect(await redis.keys(`agentkit:memorySlot:${isolated}:*`)).toEqual([]);
  });

  it("skips over-long turns rather than truncating them", async () => {
    const isolated = newScope("long");
    const small = redisMemory({ redis, maxMemoryCharacters: 20, rememberMessages: true });
    await captureTurn(
      small,
      operationContext({
        scopeKey: isolated,
        input: [userMessage("this message is definitely longer than twenty characters")],
      }),
    );
    expect(await redis.keys(`agentkit:memorySlot:${isolated}:*`)).toEqual([]);
  });

  // eve records a digest of each recall and throws if the same operationId replays differently.
  it("returns a byte-identical result when eve replays the same operationId", async () => {
    const operationId = `replay-${uniqueUserId("op")}`;
    const first = await recallContent(
      provider,
      operationContext({ scopeKey, operationId, input: [userMessage("theme")] }),
    );

    // Something else writes to the same scope between the original run and the replay.
    const tools = await provider.tools!(operationContext({ scopeKey, slot: "recall" }) as never);
    await callTool(tools, "save_memory", { text: "The user types on a mechanical keyboard" });
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
          operationContext({ scopeKey, input: [userMessage("mechanical keyboard")] }),
        ),
      (c) => c.includes("mechanical keyboard"),
    );
    expect(fresh).toContain("mechanical keyboard");
  });

  it("contributes save_memory / search_memory / forget_memory bound to the locked scope", async () => {
    const tools = await provider.tools!(operationContext({ scopeKey, slot: "recall" }) as never);
    expect(Object.keys(tools!).sort()).toEqual([
      "forget_memory",
      "read_session",
      "save_memory",
      "search_memory",
    ]);

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

    // forget_memory redacts rather than deletes: the key survives so a session still reads back in
    // order with a visible gap, but the text is gone and it can never be recalled again.
    await callTool(tools, "forget_memory", { id: saved.id });
    const doc = await pollUntil(
      () =>
        redis.json.get<Record<string, unknown>>(
          `agentkit:memorySlot:${scopeKey}:${saved.id}`,
        ) as Promise<Record<string, unknown> | null>,
      (d) => d?.deleted === true,
    );
    expect(doc!.text).toBe("");
    expect(doc!.deleted).toBe(true);
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
    // Ids are derived from position as well as text, so a replay of this turn rewrites the same
    // keys while the same sentence in another session stays a separate record.
    const expected = new Map(
      ["My cat is called Ada", "I commute on a Brompton"].map((text, subIndex) => [
        `agentkit:memorySlot:${scope}:${stableHash(`session-1|1|userMessage|${subIndex}|${text}`).slice(0, 12)}`,
        text,
      ]),
    );
    const keys = await redis.keys(`agentkit:memorySlot:${scope}:*`);
    expect(keys.sort()).toEqual([...expected.keys()].sort());

    for (const [key, text] of expected) {
      expect(await redis.json.get(key)).toEqual({
        text,
        userId: scope,
        createdAt: expect.any(Number),
        sessionId: expect.any(String),
        source: "userMessage",
        deleted: false,
        sequence: expect.any(Number),
        subIndex: expect.any(Number),
      });
    }
    // The assistant message was never written.
    expect(keys).toHaveLength(2);
  });

  it("round-trips: recall returns exactly the facts Redis is holding", async () => {
    const scope = newScope("roundtrip");
    const tools = await provider.tools!(
      operationContext({ scopeKey: scope, slot: "recall" }) as never,
    );
    await callTool(tools, "save_memory", { text: "The user always deploys on Fridays" });

    // Take the id and text from REDIS, so the recall assertion below is tied to persisted state
    // rather than to a value hardcoded in the test.
    const [key] = await redis.keys(`agentkit:memorySlot:${scope}:*`);
    expect(key).toBeDefined();
    const stored = (await redis.json.get(key!)) as { text: string; source: string };
    expect(stored.source).toBe("agent");
    const id = key!.slice(`agentkit:memorySlot:${scope}:`.length);

    await index.waitIndexing();
    const content = await pollUntil(
      () =>
        recallAt(
          provider,
          "turn.started",
          operationContext({ scopeKey: scope, input: [userMessage("when does the user deploy?")] }),
        ),
      (c) => c.includes(stored.text),
    );
    // `<id>: <text>` — the id the model would hand back to forget_memory is the Redis key part.
    expect(content).toContain(`${id}: ${stored.text}`);
  });

  it("recalls again at compaction.completed, against the same locked scope", async () => {
    const scope = newScope("compaction");
    const tools = await provider.tools!(
      operationContext({ scopeKey: scope, slot: "recall" }) as never,
    );
    await callTool(tools, "save_memory", { text: "The user's deploy target is Vercel" });
    await index.waitIndexing();

    // There is no `compaction.requested` capture any more — messages are stored as they happen, so
    // nothing is left to rescue before the summarizer runs.
    expect(provider.capture?.["compaction.requested"]).toBeUndefined();

    const content = await pollUntil(
      () =>
        recallAt(
          provider,
          "compaction.completed",
          operationContext({ scopeKey: scope, input: [userMessage("what is the deploy target?")] }),
        ),
      (c) => c.includes("Vercel"),
    );
    expect(content).toContain("Vercel");
  });

  it("rejects a model-supplied memory id that could address another scope's key", async () => {
    const tools = await provider.tools!(operationContext({ scopeKey }) as never);
    await expect(callTool(tools, "forget_memory", { id: "../../other:key" })).rejects.toThrow(
      /not a valid memory id/,
    );
  });

  it("read_session replays one session in order, with redactions left visible", async () => {
    const isolated = newScope("session");
    const sessionId = "sess-order-1";
    const context = operationContext({
      scopeKey: isolated,
      sessionId,
      input: [userMessage("I ride a Brompton")],
      messages: [
        userMessage("I ride a Brompton"),
        { role: "assistant", content: "Nice — folding bikes are great on trains." },
      ],
    });
    const both = redisMemory({ redis, rememberMessages: "all" });
    const tools = await both.tools!({
      ...context,
      turn: { id: "t", input: [], sequence: 1 },
    } as never);

    // A curated fact saved mid-turn, then both halves of the turn captured at turn end —
    // `"all"` is needed for the assistant's reply, which the default no longer stores.
    await callTool(tools, "save_memory", { text: "The user commutes by folding bike" });
    await captureTurn(both, context);
    await index.waitIndexing();

    const read = await pollUntil(
      () =>
        callTool<{
          found: boolean;
          entries: { id: string; text: string; source?: string; redacted?: boolean }[];
        }>(tools, "read_session", { sessionId }),
      (r) => r.found && r.entries.length >= 3,
    );

    // (sequence, sourceRank, subIndex): the caller speaks, the model saves, then it answers.
    expect(read.entries.map((e) => e.source)).toEqual(["userMessage", "agent", "agentMessage"]);
    expect(read.entries[0]!.text).toContain("Brompton");

    // Redaction is visible rather than silent, so the model cannot mistake it for "never said".
    const fact = read.entries.find((e) => e.source === "agent")!;
    // `both` captures the assistant's reply and therefore has no forget tool — the default
    // provider does, and they share a store, so the id is the same record.
    const defaultTools = await provider.tools!({
      ...context,
      turn: { id: "t", input: [], sequence: 1 },
    } as never);
    await callTool(defaultTools, "forget_memory", { id: fact.id });
    await index.waitIndexing();

    const after = await pollUntil(
      () =>
        callTool<{ entries: { id: string; text: string; redacted?: boolean }[] }>(
          tools,
          "read_session",
          { sessionId },
        ),
      (r) => r.entries.some((e) => e.redacted === true),
    );
    const tombstone = after.entries.find((e) => e.id === fact.id)!;
    expect(tombstone.text).toBe("[redacted]");
    expect(tombstone.redacted).toBe(true);
    // Still in place, so the session reads back with a gap the model can see.
    expect(after.entries).toHaveLength(read.entries.length);

    // And it is gone from every other read.
    const searched = await pollUntil(
      () =>
        callTool<{ memories: { id: string }[] }>(tools, "search_memory", {
          query: "folding bike commutes",
        }),
      (r) => !r.memories.some((m) => m.id === fact.id),
    );
    expect(searched.memories.some((m) => m.id === fact.id)).toBe(false);
  });
});
