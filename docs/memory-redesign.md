# Memory redesign: one store, indexed by session and source

Status: **implemented**. Written after four black-box experiments against `examples/eve-demo`; the
numbers below are measured, not estimated.

One thing here was wrong and is corrected in **Migration** below: the plan put the new indexed
fields on the *shared* `agentkit:memory` schema. That would have made every record written by
published `@upstash/agentkit-sdk@0.6.0` silently unreachable. The slot has its own keyspace instead,
and `AgentMemory` grew an opt-in `metadataSchema` rather than changing shape.

## Why change anything

`redisMemory()` currently writes the same text into two stores. Facts and captured messages go to
`AgentMemory` (`agentkit:memory:*`); turn transcripts go to `ChatHistory` (`agentkit:chat:*`).
Nothing reconciles them, and three failures follow directly from that.

**Deletion does not delete.** `forget_memory` calls `memory.forget()`, which is one `redis.del` on a
memory key. Nothing in the provider ever calls `deleteChat`. So a value the caller asked to erase
survives in the transcript no matter what — and, when message capture is on, in every other record
that happened to quote it. Measured: after the agent reported *"Done — I deleted every stored memory
about your axolotl's tank temperature"*, **5 of 29 records still contained the value**, including the
deliberately-saved canonical fact. In a second configuration the curated fact was deleted and the
verbatim user message holding the same value survived. Same root cause, opposite survivor.

**Captured messages bury curated facts.** Recall queries with the caller's current message, so a
stored *"What do you remember?"* scores near-perfectly against the next *"What do you remember?"*.
Measured on a live index: captured question **50.9**, while `User likes cucumber.` — saved
deliberately — was cut from the top 5 entirely. Asking the agent what it remembers degrades what it
remembers.

**The transcript half is unreachable.** Across 32 conversations in which `read_session` existed, was
advertised, had transcripts in Redis and `(session=…)` tags rendered in the recalled block, the model
called it **zero times**. Asked point-blank to reconstruct an earlier exchange it answered
*"MY SIDE NOT AVAILABLE"* with the answer one tool call away.

One store fixes the first, an indexed `source` fixes the second, and folding transcripts into that
store makes the third cheap enough to keep.

## The record

One document per stored item, at `agentkit:memory:<userId>:<id>`.

```ts
{
  text: string;          // redacted to "" when deleted
  userId: string;        // eve's scope key — the tenant boundary
  sessionId: string;     // the eve session this came from
  source: "agent" | "userMessage" | "agentMessage";
  deleted: boolean;
  sequence: number;      // turn.sequence within the session
  subIndex: number;      // position within the turn, per source
  createdAt: number;
}
```

`id = stableHash(sessionId + sequence + subIndex + text).slice(0, 12)`.

Deterministic, so a durable replay of the same turn writes the same key — the property that makes
capture idempotent today, preserved. Unlike `stableHash(text)` alone it lets the same sentence in two
sessions be two records, which an ordered transcript requires.

## Index schema

```ts
s.object({
  text: s.string(),                    // $smart, the only ranked field
  userId: s.string().noTokenize(),     // exact-match tenant filter
  sessionId: s.string().noTokenize(),  // exact-match, for read_session
  source: s.string().noTokenize(),     // exact-match, for the recall filter
  deleted: s.boolean(),                // exact-match, excluded everywhere but read_session
})
```

`sequence`, `subIndex` and `createdAt` stay **unindexed**: they ride along in the JSON document and
are used to sort a result set that has already been narrowed by `sessionId`. Only fields we filter on
belong in the schema, because every added field is an index rebuild.

## Ordering

Sort by `sequence`, then `sourceRank`, then `subIndex`:

```
sourceRank:  userMessage 0  →  agent 1  →  agentMessage 2
```

`source` already encodes the kind, so it doubles as the intra-turn ordinal and no index ranges need
reserving. A turn reads back in the order it happened:

```
seq 7  userMessage   0   "I ride a Brompton, by the way — what tyre pressure?"
seq 7  agent         0   "User commutes on a Brompton."        ← save_memory, mid-turn
seq 7  agentMessage  0   "For a Brompton, 100psi rear …"
```

This is why the ordering works without coordination: `save_memory` runs mid-turn and knows its
sequence (`MemoryToolsContext.turn` is non-nullable), while capture runs at `turn.completed` and
knows its own. Neither needs to know how many records the other wrote.

## Lifecycle

| eve phase | what happens |
| --- | --- |
| `turn.started` | recall — one `$smart` query filtered to `source:agent, deleted:false`, plus a `count` of this scope's non-agent records |
| `turn.completed` | write this turn's messages, per `rememberMessages` |
| `compaction.requested` | **nothing — hook dropped** |
| `compaction.completed` | recall again, against the new checkpoint |

`compaction.requested` existed to grab facts before history was summarized away. Once every turn's
messages are already stored, nothing is lost at compaction and the hook has no work. Dropping it also
removes the only context where `turn` is `null`, so there is no missing-sequence case to invent a
fallback for.

## Recall

Automatic recall returns **curated facts only** — `source: "agent"`. Captured messages are never
injected.

That makes the ranking failure structurally impossible rather than merely unlikely: a captured
question cannot outrank a saved fact when it is not in the result set. It also means passing mentions
are still *stored* — unlike turning capture off, which loses them — they are simply reached
deliberately instead of by accident.

The block ends with a pointer and a live count:

```
14 stored messages from earlier conversations are also searchable —
call `recall__search_memory`, or `recall__read_session` to read one in full.
```

A `count` returns a number rather than documents, so this is cheap. It exists because of a measured
behaviour: the model does not search unless given a concrete reason to.

## Deletion

`forget_memory` becomes an update, never a delete:

```
text     -> ""
deleted  -> true
```

Every query except `read_session` filters `deleted:false`, so a redacted record can never be recalled
or searched again. `read_session` keeps it in sequence and renders it as a tombstone, so the model
sees that something was removed rather than an unexplained gap it might try to re-derive or re-ask.

The tombstone is permanent; there is no hard delete.

**The `deleted:false` clause belongs in core `AgentMemory.recall`, not in the provider.** The
`agentkit:memory` index is shared with `defineMemorySaveTool`, ai-sdk `createMemoryTools` and the
extension's `recall_memory`. A filter applied only in the eve provider would let the other three keep
surfacing redacted content from the same store.

## Tools

| tool | what it does |
| --- | --- |
| `save_memory` | write a curated fact, `source: "agent"` |
| `search_memory` | `$smart` over `text`, `deleted:false`, any `source`; `userId` pinned |
| `forget_memory` | redact + tombstone one record by id |
| `read_session` | every record for one `sessionId`, sorted, tombstones included |

`read_session` is always contributed — there is no `rememberSessions` option any more. A session is
whatever was stored from it, so with `rememberMessages: false` it returns that session's saved facts
alone. That is honest: you cannot read back what was never kept.

`userId` stays pinned from the locked scope in all four, and the model never supplies a raw filter.
This is why memory does not call `createSearchToolDefs`, which takes its whole filter from the model
— that would let it drop the tenant clause or the `deleted` clause. What we should share instead is
`describeSchema`/`fieldGuide` from `search-tools.ts`, so `search_memory` can document its filterable
fields without inheriting that security model.

## Config, before and after

| before | after |
| --- | --- |
| `rememberMessages: true \| "fromUser" \| "fromModel" \| "all" \| false` | unchanged |
| `rememberSessions: boolean \| {…}` | **removed** — `read_session` is always contributed |
| `maxRecallCharacters`, `maxMemoryCharacters`, `topK`, `minScore` | unchanged |
| `replayCacheTtlSeconds`, `replayCachePrefix` | unchanged |
| — | *(no new options)* |

Net: one option fewer, one store fewer, one Redis index fewer, and no per-turn
read-modify-write of a growing transcript.

## Migration

**There is no migration, because nothing existing changed shape.** `AgentMemory` gained an opt-in
`metadataSchema`; omit it and the store is exactly what it was — same two indexed fields, same index,
same keyspace. The slot passes a schema *and* its own prefix (`agentkit:memorySlot`), so its stricter
index covers only records it wrote.

That rule is not a stylistic preference. Verified live: a document written without a `deleted` field
is returned by `{userId: {$eq: …}}` and by **nothing** that also filters `deleted: {$eq: false}`, and
Upstash Search rejects `$ne` outright (`Unknown field operator: $ne`). Had the shared schema been
extended in place, every existing memory would have become permanently unrecallable — still in Redis,
never returned, no error.

The one genuine behaviour change for existing callers is unrelated to the schema: `recall()` no
longer falls back to "everything for the user" when a query matches nothing.

## What this does not fix

- **The model still has to choose to search.** Facts arrive automatically; messages do not. The count
  pointer is a nudge, not a guarantee, and we have measured that the model ignores tools it is merely
  offered.
- **Redaction is per record.** If a caller asks to forget a value that also appears inside an
  unrelated stored message, only the record they targeted is redacted. A `forget_matching` sweep would
  narrow this; it cannot close it.
- **Ranking is still lexical.** `$smart` is BM25, not embeddings. "travel" will not find "Ulaanbaatar".

## Decisions taken

1. Recall filters to `source: "agent"` — measured ranking failure, structural fix.
2. `deleted` is a permanent tombstone — no hard delete.
3. `rememberSessions` removed; `read_session` always present.
4. `compaction.requested` capture dropped — redundant once messages are stored per turn.
5. Memory keeps its own schema and index; shares only schema-documentation helpers with
   `search-tools.ts`.
