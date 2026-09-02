---
"@upstash/agentkit-sdk": minor
---

feat(sdk): `AgentMemory` records carry typed `metadata`

`AgentMemory` is now generic — `AgentMemory<TMetadata>` — and `add()` accepts a `metadata` object
that `recall()` returns on each hit. Like `createdAt`, it is stored in the JSON document but
deliberately left out of the search schema, so it costs no index change and no re-index of existing
data: it rides along and comes back on the query row.

The trade-off that buys: unindexed means it cannot be filtered or searched on. A query still matches
`text` only. Anything you need to filter by has to go in the schema instead, which does mean
re-creating the index.

`@upstash/agentkit-eve`'s `redisMemory()` is the first consumer, storing
`{ source, conversationId? }` — where a memory came from, and which conversation produced it.
