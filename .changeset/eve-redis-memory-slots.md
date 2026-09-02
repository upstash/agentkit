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
- `read()` does not trust a single "document absent" answer for a scope key it has written.
  `@upstash/redis@1.38.0` sends its read-your-writes `upstash-sync-token` one request behind, so an
  `HMGET` immediately after the `EVAL` write can be served by a replica that hasn't caught up — and
  `fileMemory()` would react by starting a fresh document and taking a conflict. A bounded set of
  written keys turns that into a confirming re-read; genuinely absent documents (a new scope, a
  `ttlSeconds` expiry) still resolve to `null` on the first read.

The `./memory` entry point imports `eve/memory` and `eve/memory/file`, added in eve **0.45.1** and
**0.45.2**, so it needs **eve ≥ 0.45.2**. The package's `eve` peer range stays `">=0.32.0"`: the root
and `./sandbox` entry points still work all the way down, and only this subpath names the newer
modules.

`redisMemory()` is covered at both ends: an offline suite spies `AgentMemory`'s `recall`/`add` and
scripts the search index to assert that recall and capture fire at all four lifecycle hooks with the
right scope, ranking knobs and Redis Search filter; a live suite asserts the JSON documents that
land in Redis and recalls them back, including through the compaction hooks.

### `redisMemory()` configuration

Automatic capture is **off by default**, and the config names say which phase they belong to:

| option | default | notes |
| --- | --- | --- |
| `autoCapture` | `false` | `false` \| `true`/`"fromUser"` \| `"fromModel"` \| `"all"` \| an extractor function |
| `memoryTools` | `true` | contributes `save_memory` + `forget_memory` |
| `conversations` | `false` | `true` or `{ prefix, indexName, ttlSeconds, maxReadMessages }` |
| `maxRecallCharacters` | `4000` | budget for the recalled block |
| `maxMemoryCharacters` | `2048` | longest single stored memory |
| `buildRecallQuery` | user text of the turn | builds the BM25 query |

`autoCapture` defaults to `false` because captured utterances and curated facts share one BM25
ranking, and the utterances win. Recall queries with the user's current message, so a stored
*"What do you remember?"* scores near-perfectly against the next *"What do you remember?"* and
pushes real facts out of `topK`. Measured against a live index: a captured question scored **50.9**
while `User likes cucumber.` — saved deliberately through `save_memory` — was cut from the top 5
entirely. Asking the agent what it remembers is what degraded what it remembered. `"fromModel"` and
`"all"` are worse still (the assistant's text is derived from the recalled block, so the agent
re-memorizes its own restatements) and their JSDoc says so.

The single `autoCapture` union replaces the old `capture: boolean` + `extract` pair, which allowed
the illegal state `capture: false` alongside an `extract` function that silently never ran.

### Conversations

`conversations: true` also stores each turn's transcript through core `ChatHistory` (keyed by the
eve session id), stamps that id on every memory captured or saved in the turn, tags recalled
memories `conversation=<id>`, and contributes a `read_conversation` tool. That is small-to-big
retrieval: individual memories stay individually ranked, and the model expands a match into the
surrounding exchange **on demand** instead of transcripts being injected into every prompt — so a
remembered *question* can lead to the answer that followed it. The recalled block is filtered out of
what gets stored, so recall output never round-trips into the transcript recall later expands. The
pointer is not a snapshot: a memory captured mid-conversation points at a transcript that keeps
growing.

`examples/eve-demo` now declares both slots and ships a mocked-model e2e eval
(`AGENTKIT_MOCK_MODEL=1 npx eve eval`) that exercises them against real Redis in CI — including a
gate that reads the captured memory straight out of Redis, tagged with a per-run nonce.
