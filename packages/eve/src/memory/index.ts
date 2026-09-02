/**
 * `redisDocuments()` — Upstash Redis storage for **eve**'s native memory feature
 * (`eve/memory`, https://eve.dev/docs/memory).
 *
 * eve's built-in `fileMemory()` provider keeps a small, model-curated list of durable facts and
 * replays the whole document before every turn. What it does *not* ship is somewhere to put that
 * document outside Vercel: with no `backend` it resolves to in-memory storage under `eve dev`, to
 * Vercel Blob on Vercel, and **errors everywhere else**. `redisDocuments()` is that backend, on the
 * Redis you already have:
 *
 * ```ts
 * // agent/memory/profile.ts
 * import { defineMemory } from "eve/memory";
 * import { byPrincipal } from "eve/memory/scope";
 * import { fileMemory } from "eve/memory/file";
 * import { redisDocuments } from "@upstash/agentkit-eve/memory";
 *
 * export default defineMemory({
 *   description: "Remember stable facts and preferences about the caller.",
 *   provider: fileMemory({ backend: redisDocuments() }),
 *   scope: byPrincipal,
 * });
 * ```
 *
 * Recall behaviour and the `save_memory` / `remove_memory` tools stay eve's own and unchanged —
 * only the storage moves. See `./documents.ts` for how the compare-and-swap and the byte-exact
 * round trip are implemented.
 *
 * This does not replace `defineMemoryRecallTool` / `defineMemorySaveTool` from the package root.
 * Those are plain eve tools you drop into `agent/tools/*.ts`: they work on any eve version, need no
 * memory slot, and are the right thing when you want memory to be purely model-driven.
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
