---
"@upstash/agentkit-sdk": minor
---

feat(sdk): `AgentMemory` can carry extra **indexed** fields, and no longer falls back on a miss

`AgentMemory` accepts a `metadataSchema` — Upstash Search field builders such as
`{ source: s.string().noTokenize(), deleted: s.boolean() }` — whose values are supplied per record as
`metadata` and can then be filtered on in `recall({ filter })`, the new `list({ filter })`, and the
new `count({ filter })`. Metadata is stored as top-level fields, because Redis Search indexes JSON by
path and a nested object would not be filterable.

**Give an extended store its own `prefix`.** A schema describes an index and an index covers a
keyspace: pointing a stricter schema at a keyspace that already holds records written without those
fields makes those records permanently unreachable, because Upstash Search does not match a missing
field against `{$eq: …}` and has no `$ne` to work around it. Its own prefix means its own keyspace
and its own index, so nothing written earlier is in scope.

Omit `metadataSchema` and this is exactly the store it was: the same two indexed fields, the same
index, no re-index, existing records untouched.

**Behaviour change:** `recall()` no longer falls back to "everything for the user" when a `query`
matches nothing — it returns nothing. The fallback made a miss indistinguishable from a hit, so a
caller (or a model) would report unrelated memories as results; one black-box test had an agent
answer "I do not see that in the stored entries" from an unfiltered dump it mistook for a filtered
one. Omitting the query is still how you ask for the whole set. This affects every caller of
`recall`, including the memory tools in `@upstash/agentkit-ai-sdk`, `@upstash/agentkit-eve` and the
eve extension: a model passing a placeholder like "everything" now gets nothing back.
