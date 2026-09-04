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
  `turn.started` / `compaction.completed`, automatic capture at `turn.completed`, plus
  `<slot>__save_memory`, `<slot>__search_memory`, `<slot>__read_session` and (outside the modes that
  store the assistant's replies) `<slot>__forget_memory`, bound to the slot's locked scope. Where `fileMemory()` replays one bounded, model-curated document, this
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

The config names say which phase they belong to:

| option | default | notes |
| --- | --- | --- |
| `rememberMessages` | `true` (= `"fromUser"`) | `"all"` \| `"fromModel"` \| `false` |
| `maxRecallCharacters` | `4000` | budget for the recalled block |
| `maxMemoryCharacters` | `2048` | longest single stored memory |

`save_memory`, `search_memory`, `forget_memory` and `read_session` are always contributed — a memory slot with no way to save, search or forget
would be a strange thing to declare. `search_memory` is the manual counterpart to automatic recall,
which only ever surfaces what is relevant to the *current* message.

**Know the trade-off on `rememberMessages` before leaving it on.** Captured utterances and curated facts
share one BM25 ranking, and recall queries with the user's current message — so a stored
*"What do you remember?"* scores near-perfectly against the next *"What do you remember?"* and
pushes real facts out of `topK`. Measured against a live index: a captured question scored **50.9**
while `User likes cucumber.`, saved deliberately through `save_memory`, was cut from the top 5
entirely. Set `rememberMessages: false` for a model-curated slot. `"fromModel"` and `"all"` are worse
still (the assistant's text is derived from the recalled block, so the agent re-memorizes its own
restatements) and their JSDoc says so.

### Reading a conversation back

Every memory carries the eve session id it was written in, recalled memories are tagged
`session=<id>`, and `<slot>__read_session` replays that session. That is small-to-big retrieval:
individual memories stay individually ranked, and the model expands a match into the surrounding
exchange **on demand** rather than transcripts being injected into every prompt — so a remembered
*question* can lead to the answer that followed it. The recalled block is excluded from what gets
captured, so recall output never round-trips back into the store.

`examples/eve-demo` now declares both slots and ships a mocked-model e2e eval
(`AGENTKIT_MOCK_MODEL=1 npx eve eval`) that exercises them against real Redis in CI — including a
gate that reads the captured memory straight out of Redis, tagged with a per-run nonce.

### One store, indexed by session and source

Everything the slot keeps — facts the model saved and the turns it captured — lives in one keyspace
of its own (`agentkit:memorySlot`), with `sessionId`, `source` and `deleted` as indexed fields. There
is no separate transcript store, so there is nothing to fall out of sync with.

That shape buys three things black-box testing showed were broken when facts and transcripts were
kept apart:

- **Automatic recall injects only `source: "agent"`** — facts the model deliberately saved. Captured
  turns share the store but not the ranking, so a stored *"What do you remember?"* can no longer
  outrank a real fact on the next identical question. Measured on a live index before the change: the
  captured question scored **50.9** while `User likes cucumber.` was cut from the top 5 entirely.
- **`forget_memory` redacts rather than deletes.** The text is erased and `deleted` set, so the entry
  can never be recalled or searched again, but it stays in place and `read_session` renders it as
  `[redacted]` — a reader that saw a silent gap could reasonably re-derive or re-ask the very thing
  that was removed. Previously deletion could not be honest at all: the same value survived in a
  transcript nothing ever deleted from, and 5 of 29 records still contained a value the agent
  reported it had permanently erased.
- **`read_session` replays a session in order** — `(sequence, source, subIndex)`, so the caller's
  message, the fact saved mid-turn, and the reply come back the way they happened.

`compaction.requested` capture is gone: messages are stored as they happen, so the summarizer takes
nothing with it, and it was the only context where the ordering `sequence` could be null.

### `"all"` and `"fromModel"` do not get `forget_memory`

Those modes store the assistant's replies, and an assistant reply confirming a deletion quotes the
text it just deleted — so erasing something writes a fresh copy of it. Measured over 18 black-box
conversations: after the model was asked to forget one fact, the curated fact was correctly redacted
and the phrase survived in three other records, every one an assistant reply *about* the deletion.

A tool that reports "permanently deleted every stored item that mentioned it" while that happens is
worse than no tool, so those two modes contribute `save_memory`, `search_memory` and `read_session`
only. Nothing becomes unreachable — deletion just stops claiming to be possible where it is not.

This is also why the default is `"fromUser"` rather than `"all"`: in the same run, assistant replies
were 18 of 41 stored records — half the store, and the entire source of the leak.

**`@upstash/redis` peer floor raised to `>=1.38.4`.** `redisDocuments()` reads a document straight
after writing it, so it depends on the client's read-your-writes guarantee. Through 1.38.0 the
`upstash-sync-token` was sent one request late, and the backend worked around it by re-reading an
"absent" answer for a key it had written; 1.38.4 fixes the ordering upstream, so the workaround is
gone and a read is a single `HMGET` again.

