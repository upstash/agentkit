/**
 * Memory backends for **eve**'s native memory feature (`eve/memory`, https://eve.dev/docs/memory),
 * powered by **Upstash Redis**. Two integrations live behind this entry point, because eve's memory
 * API has two genuinely different seams and Redis is the right answer at both:
 *
 * | | {@link redisDocuments} (`./documents.ts`) | {@link redisMemory} (`./provider.ts`) |
 * | --- | --- | --- |
 * | eve seam | `MemoryDocumentBackend` (storage only) | `MemoryProvider` (recall/capture/tools) |
 * | Recall | eve's: the **whole** document, every turn | ours: **top-K BM25** for the turn's query |
 * | Capture | none — the model calls `save_memory` | opt-in `autoCapture` (plus a save tool) |
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
 * Neither replaces `defineMemoryRecallTool`/`defineMemorySaveTool` from the package root. Those are
 * plain eve tools you drop into `agent/tools/*.ts` — they work on any eve version, need no memory
 * slot, and are the right thing when you want memory to be purely model-driven.
 *
 * ## eve version
 *
 * This entry point imports `eve/memory` and `eve/memory/file`, which eve added in **0.45.1** and
 * **0.45.2** respectively — newer than the package's `>=0.32.0` peer floor, which is set by the
 * (much older) root and `./sandbox` entry points. Importing `@upstash/agentkit-eve/memory` on an
 * older eve fails at module load with an unresolved-subpath error. The peer range is deliberately
 * not raised for this: the other entry points still work all the way down to eve 0.32.
 */
export { RedisMemoryDocumentBackend, redisDocuments } from "./documents.js";
export type { RedisDocumentsConfig } from "./documents.js";

export { redisMemory } from "./provider.js";
export type {
  AutoCapture,
  RedisMemoryCaptureContext,
  RedisMemoryConfig,
  RedisMemoryConversationsConfig,
  RedisMemoryRecallContext,
} from "./provider.js";
