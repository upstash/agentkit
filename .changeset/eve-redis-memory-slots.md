---
"@upstash/agentkit-eve": minor
---

feat(eve): add `@upstash/agentkit-eve/memory` — Upstash Redis behind eve's native memory slots

A new subpath export with **two** integrations for eve's [memory](https://eve.dev/docs/memory)
feature (`agent/memory/<slot>.ts`), because eve exposes two genuinely different seams:

- **`redisDocuments()`** — a `MemoryDocumentBackend` for eve's built-in `fileMemory()` provider, a
  drop-in replacement for its Vercel Blob storage: `fileMemory({ backend: redisDocuments() })`. This
  closes eve's documented gap — with no `backend`, `fileMemory()` only resolves storage under
  `eve dev` (process-local) and on Vercel with a Blob store attached, and errors everywhere else.
- **`redisMemory()`** — a full `MemoryProvider` over the SDK's `AgentMemory`: ranked BM25 recall at
  `turn.started` / `compaction.completed`, automatic capture at `turn.completed` /
  `compaction.requested`, plus `<slot>__save_memory` and `<slot>__forget_memory` tools bound to the
  slot's locked scope. Where `fileMemory()` replays one bounded, model-curated document, this
  retrieves the top-K memories relevant to the current turn from an unbounded store and needs no
  tool call to remember anything.

Both are additive. `defineMemoryRecallTool` / `defineMemorySaveTool` and every other existing memory
path are unchanged, work on any supported eve, and remain the right choice for purely model-driven
memory with no memory slot.

Implementation notes worth knowing:

- eve requires `MemoryDocumentBackend.write()` to be an optimistic-concurrency replace that throws
  `MemoryDocumentConflictError` on a stale `expectedVersion`. `@upstash/redis` is REST-only, so there
  is no `WATCH`/`MULTI`; the compare-and-set is a Lua `EVAL`, **verified live** against an Upstash
  Redis instance (`redis.eval` works over the REST API with auto-pipelining on, Lua table returns
  round-trip, and `HGET`/`HSET`/`EXPIRE` behave normally inside the script). A test asserts that
  exactly one of eight concurrent writers wins.
- Documents are stored with a marker prefix so `@upstash/redis`'s automatic reply deserialization
  can't turn a JSON-looking document (`123`, `{"a":1}`) into a number/object on read.
- Automatic capture ends with `waitIndexing()` (`waitForIndexing`, default `true`), because Upstash
  Search indexing otherwise lags far past the next turn — measured end to end. eve runs capture after
  the response is delivered, so this costs the caller nothing.
- Recall is returned as one keyed message and cached per eve `operationId`, so a durable replay
  cannot trip eve's "recall operation replayed with a different result" check.

The `./memory` entry point imports `eve/memory` and `eve/memory/file`, added in eve **0.45.1** and
**0.45.2**, so it needs **eve ≥ 0.45.2**. The package's `eve` peer range stays `">=0.32.0"`: the root
and `./sandbox` entry points still work all the way down, and only this subpath names the newer
modules.

`examples/eve-demo` now declares both slots and ships a mocked-model e2e eval
(`AGENTKIT_MOCK_MODEL=1 npx eve eval`) that exercises them against real Redis in CI.
