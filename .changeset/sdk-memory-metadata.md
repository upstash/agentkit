---
"@upstash/agentkit-sdk": minor
---

feat(sdk): typed indexed metadata on `AgentMemory`, plus `get`/`list`/`count`

`AgentMemory` accepts a `metadataSchema` of Upstash Search field builders, whose values are supplied
per record as `metadata` and can then be filtered on:

```ts
const memory = new AgentMemory({
  redis,
  prefix: "myapp:memory", // ← its own prefix; see below
  metadataSchema: { source: s.string().noTokenize(), deleted: s.boolean() },
});

await memory.add({ text: "…", userId: "u1", metadata: { source: "agent", deleted: false } });
await memory.recall({ userId: "u1", query: "…", filter: { source: { $eq: "agent" } } });
```

The schema types everything: `metadata` and each `filter` are derived from it, so a wrong operand
type or an undeclared field is a compile error rather than a query that quietly matches nothing. To
narrow a derived type, pass it as a second argument, constrained to the schema:
`new AgentMemory<typeof schema, { source: "agent" | "userMessage" }>(…)`.

Also new: `list({ userId, filter, limit })` (filter-first, unranked), `count({ userId, filter })`,
and `get({ userId, id })` — a direct-key read, for when you have an id and a bounded search page
could hide it.

**Give an extended store its own `prefix`.** A stricter schema pointed at a keyspace that already
holds records written without those fields makes them permanently unreachable: Upstash Search does
not match a missing field against `{$eq: …}` and has no `$ne`. Omitting `metadataSchema` leaves the
store exactly as it was.

**Behaviour change:** `recall()` no longer falls back to "everything for the user" when a `query`
matches nothing; it returns nothing, since the fallback made a miss indistinguishable from a hit.
Omitting the query is still how you ask for the whole set. This reaches every caller of `recall`,
including the memory tools in `@upstash/agentkit-ai-sdk`, `@upstash/agentkit-eve` and the extension.
