/**
 * Memory backends for **eve**'s native memory feature (`eve/memory`, https://eve.dev/docs/memory),
 * powered by **Upstash Redis**. Two integrations live behind this entry point, because eve's memory
 * API has two genuinely different seams and Redis is the right answer at both:
 *
 * | | {@link redisDocuments} (`./documents.ts`) | {@link redisMemory} (`./provider.ts`) |
 * | --- | --- | --- |
 * | eve seam | `MemoryDocumentBackend` (storage only) | `MemoryProvider` (recall/capture/tools) |
 * | Recall | eve's: the **whole** document, every turn | ours: **top-K BM25** for the turn's query |
 * | Capture | none — the model calls `save_memory` | opt-in `rememberMessages` (plus a save tool) |
 * | Deletion | eve's `remove_memory` (by index) | our `forget_memory` (by id) |
 * | Size | bounded: 4,000 recalled chars / 64 KiB stored | unbounded store, bounded recall |
 * | Redis shape | one hash per scope key | one JSON doc per memory + a Redis Search index |
 *
 * Pick `fileMemory({ backend: redisDocuments() })` when you want eve's own semantics — a small,
 * model-curated list of durable facts — but need it to survive outside Vercel Blob. This is the
 * narrow, faithful fix for eve's documented gap: with no `backend`, `fileMemory()` resolves to
 * in-memory storage under `eve dev`, to Vercel Blob on Vercel, and **errors everywhere else**.
 * Pick `redisMemory()` when the memory should grow past what fits in a 4,000-character preamble and
 * should be *retrieved* rather than replayed wholesale, or when you want conversation-aware recall.
 *
 * They compose: nothing stops an agent from declaring both slots (see `examples/eve-demo`).
 *
 * ## Lifecycle
 *
 * {@link redisMemory} hooks the two points eve 0.84+ gives a memory provider: it recalls at
 * `turn.started` and writes at `turn.completed` (capture needs the turn's own input). eve no longer
 * has a `compaction.completed` recall hook, so recall is not repeated after compaction.
 *
 * | phase | `fileMemory({ backend: redisDocuments() })` | {@link redisMemory} |
 * | --- | --- | --- |
 * | `turn.started` | read the document, inject it whole | ranked recall → one keyed message, before the model runs |
 * | `turn.completed` | — | write captures (`rememberMessages`), wait for indexing |
 *
 * Capture runs *after* the response is delivered, which is what makes the `waitIndexing()` there
 * free. Recall is cached per eve `operationId` because eve treats that id as an idempotency key and
 * rejects a replay that differs.
 *
 * Neither replaces `defineMemoryRecallTool`/`defineMemorySaveTool` from the package root. Those are
 * plain eve tools you drop into `agent/tools/*.ts` — they work on any eve version, need no memory
 * slot, and are the right thing when you want memory to be purely model-driven.
 *
 * ## eve version
 *
 * The package's `eve` peer is `>=0.87.0 || >=1.0.0-0` (eve 0.87 changed the memory-document and
 * sandbox signatures this package implements; the second arm exists because semver never matches a
 * prerelease such as `1.0.0-rc.9` against `>=0.87.0`). This entry point would load on eve 0.45.2+
 * (`eve/memory` landed in 0.45.1, `eve/memory/file` in 0.45.2), but a single range covers the whole
 * public surface. `toolLabels: false` on {@link redisMemory} needs eve 1.0.0-rc.7+ and is typed so it
 * only compiles there.
 *
 * eve 1.0.0-rc.8 names the memory store on provider tool calls as well as on recall and capture:
 * the trace attribute `gen_ai.memory.store.id` is eve's `memory.scope.key`, which is exactly the
 * partition {@link redisMemory} stores under (`agentkit:memorySlot:<scope.key with : → _>:<id>`), so a
 * trace query by store id finds a scope's `save_memory`/`search_memory`/`forget_memory`/
 * `read_session` calls with no provider-side change.
 */
export { RedisMemoryDocumentBackend, redisDocuments } from "./documents.js";
export type { RedisDocumentsConfig } from "./documents.js";

export { redisMemory } from "./provider.js";
export type { MemorySource } from "./provider.js";
export type {
  RememberMessages,
  RedisMemoryCaptureContext,
  RedisMemoryConfig,
  RedisMemoryRecallContext,
  RedisMemoryToolInputs,
  RedisMemoryToolLabel,
  RedisMemoryToolName,
} from "./provider.js";
