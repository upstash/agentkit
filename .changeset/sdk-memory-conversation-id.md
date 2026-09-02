---
"@upstash/agentkit-sdk": minor
---

feat(sdk): `AgentMemory` records can carry a `conversationId`

`add()` accepts an optional `conversationId` and `recall()` returns it. Like `createdAt`, it is
stored in the JSON document but **not** added to the search schema, so it costs no index change and
no re-index of existing data — it simply rides along and comes back on the query row.

This is the pointer half of small-to-big retrieval: rank at memory granularity, where BM25
discriminates well, then expand a match into the surrounding transcript on demand. `ChatHistory` is
the natural other half — a memory's `conversationId` is a `ChatHistory` `sessionId` — and
`@upstash/agentkit-eve`'s `redisMemory({ conversations: true })` wires the two together.
