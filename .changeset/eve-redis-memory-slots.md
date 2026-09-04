---
"@upstash/agentkit-eve": minor
---

feat(eve): add `@upstash/agentkit-eve/memory` — Upstash Redis behind eve's memory slots

A new subpath with two integrations for eve's [memory](https://eve.dev/docs/memory) feature
(`agent/memory/<slot>.ts`), because eve exposes two different seams:

- **`redisDocuments()`** — a `MemoryDocumentBackend` for eve's built-in `fileMemory()`, replacing its
  Vercel Blob storage: `fileMemory({ backend: redisDocuments() })`. Without a `backend`,
  `fileMemory()` only resolves storage under `eve dev` and on Vercel with a Blob store attached.
- **`redisMemory()`** — a full `MemoryProvider` over the SDK's `AgentMemory`: ranked BM25 recall at
  `turn.started` / `compaction.completed`, capture at `turn.completed`, and the tools
  `<slot>__save_memory`, `<slot>__search_memory`, `<slot>__read_session` and `<slot>__forget_memory`,
  bound to the slot's locked scope. Where `fileMemory()` replays one curated document, this recalls
  the top-K memories relevant to the current turn and needs no tool call to remember anything.

Both are additive: `defineMemoryRecallTool` / `defineMemorySaveTool` are unchanged and remain the
right choice for model-driven memory with no slot.

**Requirements.** The subpath imports `eve/memory` and `eve/memory/file` (added in eve 0.45.1 and
0.45.2), so it needs **eve ≥ 0.45.2** — the package's `eve` peer stays `>=0.32.0` because the root
and `./sandbox` entry points still work further back. The `@upstash/redis` peer floor moves to
**`>=1.38.4`**, whose read-your-writes fix `redisDocuments()` relies on.

**`redisMemory()` options:** `rememberMessages` (default `true`, meaning `"fromUser"`; also `"all"`,
`"fromModel"`, `false`), `maxRecallCharacters` (4000), `maxMemoryCharacters` (2048), plus `topK`,
`minScore`, `prefix`, `indexName`.

Three behaviours worth knowing before you configure it:

- **Automatic recall injects saved facts only.** Captured messages share the store but not the
  ranking, and are reached on demand through `search_memory` / `read_session`. Otherwise a stored
  *"What do you remember?"* outranks real facts on the next identical question.
- **`forget_memory` redacts rather than deletes.** The text is erased and the entry marked deleted,
  so it can never be recalled or searched again, but `read_session` renders it as `[redacted]` — a
  silent gap invites re-deriving the very thing that was removed.
- **`"all"` and `"fromModel"` do not get `forget_memory`.** Those modes store the assistant's
  replies, and a reply confirming a deletion quotes the text it deleted — so erasing something would
  write a fresh copy of it. They contribute `save_memory`, `search_memory` and `read_session` only.

Everything the slot keeps lives in one keyspace of its own (`agentkit:memorySlot`) with `sessionId`,
`source` and `deleted` indexed, so there is no separate transcript store to fall out of sync.
Recalled memories are tagged `session=<id>`, and `read_session` replays that session in order.
