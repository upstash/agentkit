/**
 * Memory backends for **Eve**'s native memory feature (`eve/memory`, https://eve.dev/docs/memory),
 * powered by **Upstash Redis**. Two integrations live here, because eve's memory API has two
 * genuinely different seams and Redis is the right answer at both of them:
 *
 * 1. {@link redisDocuments} — a `MemoryDocumentBackend` for eve's built-in `fileMemory()` provider.
 *    Drop-in replacement for the Vercel Blob backend, exactly like `vercelBlob()`:
 *
 *    ```ts
 *    // agent/memory/profile.ts
 *    import { defineMemory } from "eve/memory";
 *    import { byPrincipal } from "eve/memory/scope";
 *    import { fileMemory } from "eve/memory/file";
 *    import { redisDocuments } from "@upstash/agentkit-eve/memory";
 *
 *    export default defineMemory({
 *      description: "Remember stable facts and preferences about the caller.",
 *      provider: fileMemory({ backend: redisDocuments() }),
 *      scope: byPrincipal,
 *    });
 *    ```
 *
 * 2. {@link redisMemory} — a full `MemoryProvider` (recall + capture + tools) built on AgentKit's
 *    {@link AgentMemory}, so a slot gets *ranked* recall and *automatic* capture:
 *
 *    ```ts
 *    // agent/memory/recall.ts
 *    import { defineMemory } from "eve/memory";
 *    import { byPrincipal } from "eve/memory/scope";
 *    import { redisMemory } from "@upstash/agentkit-eve/memory";
 *
 *    export default defineMemory({
 *      description: "Recall what the caller has told this agent before.",
 *      provider: redisMemory({ topK: 5 }),
 *      scope: byPrincipal,
 *    });
 *    ```
 *
 * ## Why both, and which one to pick
 *
 * They are not competing implementations of the same thing — they sit at different layers of eve's
 * memory stack and solve different problems:
 *
 * | | {@link redisDocuments} | {@link redisMemory} |
 * | --- | --- | --- |
 * | eve seam | `MemoryDocumentBackend` (storage only) | `MemoryProvider` (recall/capture/tools) |
 * | Recall | eve's: the **whole** document, every turn | ours: **top-K BM25** for the turn's query |
 * | Capture | none — the model calls `save_memory` | **automatic**, every turn (plus a save tool) |
 * | Deletion | eve's `remove_memory` (by index) | our `forget_memory` (by id), via `AgentMemory.forget` |
 * | Size | bounded: 4,000 recalled chars / 64 KiB stored | unbounded store, bounded recall |
 * | Redis shape | one hash per scope key | one JSON doc per memory + a Redis Search index |
 *
 * Pick `fileMemory({ backend: redisDocuments() })` when you want eve's own semantics — a small,
 * model-curated list of durable facts — but need it to survive outside Vercel Blob. This is the
 * narrow, faithful fix for eve's documented gap: with no `backend`, `fileMemory()` resolves to
 * in-memory storage under `eve dev`, to Vercel Blob on Vercel, and **errors everywhere else**.
 * Pick `redisMemory()` when the memory should grow past what fits in a 4,000-character preamble and
 * should be *retrieved* rather than replayed wholesale, or when you don't want to rely on the model
 * remembering to call `save_memory`.
 *
 * They compose: nothing stops an agent from declaring both slots (see `examples/eve-demo`).
 *
 * Neither replaces {@link defineMemoryRecallTool}/{@link defineMemorySaveTool} from the package
 * root. Those are plain eve tools you drop into `agent/tools/*.ts` — they work on any eve version,
 * need no memory slot, and are the right thing when you want memory to be purely model-driven.
 *
 * ## Optimistic concurrency without WATCH/MULTI (verified, not assumed)
 *
 * `MemoryDocumentBackend.write()` is a conditional replace: it must throw eve's
 * `MemoryDocumentConflictError` when the caller's `expectedVersion` no longer matches the stored
 * one (`fileMemory()` catches it, re-reads, and retries up to 8 times). `@upstash/redis` speaks the
 * **REST** API, which is stateless and therefore has no `WATCH`/`MULTI` — so the compare and the
 * swap have to happen inside a single server-side command.
 *
 * That command is `EVAL`. **Verified live against an Upstash Redis instance** (2026-09, an
 * `upstash start-redis` database on the current REST API), not assumed:
 * - `EVAL` is accepted over the REST API and through `@upstash/redis`'s `redis.eval(script, keys,
 *   args)`, including with auto-pipelining enabled (the default);
 * - a Lua table return (`{0, currentVersion}` / `{1, newVersion}`) round-trips as a JSON array, so
 *   the script can report *why* it refused and what the current version is;
 * - `HGET`/`HSET`/`EXPIRE` inside the script behave normally, and `SCRIPT LOAD` works too.
 *
 * The script ({@link CAS_SCRIPT}) is sent with every write rather than cached as a SHA + `EVALSHA`:
 * it is ~300 bytes, writes are rare (one per `save_memory`/`remove_memory` call), and `EVALSHA`
 * would need a `NOSCRIPT` fallback path for no measurable gain.
 *
 * ## Storage layout
 *
 * `redisDocuments()` stores one Redis **hash** per eve scope key at
 * `agentkit:memoryFile:<scopeKey>` with two fields, `content` and `version`. A hash (rather than a
 * JSON string) keeps the Lua script trivial: it compares one field and writes two.
 *
 * The stored `content` carries a short {@link CONTENT_MARKER} prefix, stripped on read. This is not
 * decoration: `@upstash/redis` **auto-deserializes** replies, so a document whose text happens to
 * be valid JSON (`123`, `{"a":1}`) comes back as a `number`/`object` instead of the exact string
 * that was written — measured, not theorized. The marker makes every stored value un-parseable as
 * JSON, which guarantees `read()` returns the document byte-for-byte as `write()` received it.
 * eve's own document format starts with an HTML comment today, but the backend contract is "any
 * UTF-8 string" and a corrupted round-trip would surface as an opaque
 * "Memory backend returned an invalid versioned memory document." much later.
 *
 * `redisMemory()` stores nothing new: it is {@link AgentMemory} (one JSON doc per memory at
 * `agentkit:memory:<userId>:<id>`, one shared Redis Search index), keyed by eve's scope key. That
 * means the 10-index cap on an Upstash database is not affected by adding memory slots, and the
 * store is the same one `defineMemorySaveTool` writes to.
 *
 * ## Indexing lag on the capture path
 *
 * Upstash Redis Search indexes asynchronously, and the lag after a bare `json.set` is much longer
 * than "the next turn": in an end-to-end eve run, a fact captured at `turn.completed` was still
 * invisible to recall eight turns and ten seconds later, and only appeared minutes afterwards.
 * Automatic capture would therefore look broken exactly when it matters. So capture ends with
 * `waitIndexing()` (see `waitForIndexing`) — free, because eve runs capture *after* the response
 * is delivered — and recall stays wait-free on the hot path.
 *
 * ## eve version
 *
 * This entry point imports `eve/memory` and `eve/memory/file`, which eve added in **0.45.1** and
 * **0.45.2** respectively — newer than the package's `>=0.32.0` peer floor, which is set by the
 * (much older) root and `./sandbox` entry points. Importing `@upstash/agentkit-eve/memory` on an
 * older eve fails at module load with an unresolved-subpath error. The peer range is deliberately
 * not raised for this: the other entry points still work all the way down to eve 0.32.
 */
export { RedisMemoryDocumentBackend, redisDocuments } from "./memory-documents.js";
export type { RedisDocumentsConfig } from "./memory-documents.js";

export { defaultExtract, redisMemory } from "./memory-provider.js";
export type {
  RedisMemoryCaptureContext,
  RedisMemoryConfig,
  RedisMemoryRecallContext,
} from "./memory-provider.js";
