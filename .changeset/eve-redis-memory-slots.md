---
"@upstash/agentkit-eve": minor
---

feat(eve): add `@upstash/agentkit-eve/memory` — Upstash Redis storage for eve's memory slots

A new subpath export with one integration for eve's [memory](https://eve.dev/docs/memory) feature
(`agent/memory/<slot>.ts`): **`redisDocuments()`**, a `MemoryDocumentBackend` for eve's built-in
`fileMemory()` provider.

```ts
provider: fileMemory({ backend: redisDocuments() })
```

This closes eve's documented gap. With no `backend`, `fileMemory()` resolves storage to an
in-process `Map` under `eve dev`, to Vercel Blob on Vercel, and **errors everywhere else** — so
eve's own memory feature has nowhere to live off Vercel. Recall behaviour and the
`save_memory` / `remove_memory` tools stay eve's own and unchanged; only the storage moves.

It is additive: `defineMemoryRecallTool` / `defineMemorySaveTool` and every other existing memory
path are untouched, work on any supported eve, and remain the right choice for purely model-driven
memory with no memory slot.

Implementation notes worth knowing:

- eve requires `MemoryDocumentBackend.write()` to be an optimistic-concurrency replace that throws
  `MemoryDocumentConflictError` on a stale `expectedVersion`. `@upstash/redis` is REST-only, so
  there is no `WATCH`/`MULTI`; the compare-and-set is a Lua `EVAL`, **verified live** against an
  Upstash Redis instance (`redis.eval` works over the REST API with auto-pipelining on, Lua table
  returns round-trip, and `HGET`/`HSET`/`EXPIRE` behave normally inside the script). A test asserts
  that exactly one of eight concurrent writers wins.
- Documents are stored with a marker prefix so `@upstash/redis`'s automatic reply deserialization
  can't turn a JSON-looking document (`123`, `{"a":1}`) into a number/object on read.
- `read()` does not trust a single "document absent" answer for a scope key it has written.
  `@upstash/redis@1.38.0` sends its read-your-writes `upstash-sync-token` one request behind, so an
  `HMGET` immediately after the `EVAL` write can be served by a replica that hasn't caught up — and
  `fileMemory()` would react by starting a fresh document and taking a conflict. A bounded set of
  written keys turns that into a confirming re-read; genuinely absent documents (a new scope, a
  `ttlSeconds` expiry) still resolve to `null` on the first read.

The `./memory` entry point imports `eve/memory` and `eve/memory/file`, added in eve **0.45.1** and
**0.45.2**, so it needs **eve ≥ 0.45.2**. The package's `eve` peer range stays `">=0.32.0"`: the
root and `./sandbox` entry points still work all the way down, and only this subpath names the
newer modules.

`examples/eve-demo` declares the slot and ships a mocked-model e2e eval
(`AGENTKIT_MOCK_MODEL=1 npx eve eval`) that exercises it against real Redis in CI — including a gate
that reads the saved document straight out of Redis, tagged with a per-run nonce.
