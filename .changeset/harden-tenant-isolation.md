---
"@upstash/agentkit-sdk": minor
"@upstash/agentkit-ai-sdk": minor
"@upstash/agentkit-eve": minor
---

Tenant-isolation hardening, a type-safe reactive search index, and a consistent `prefix`/`indexName`/`userId`/`toolName` API. Contains breaking changes.

**Tenant isolation**

- `ChatHistory` is keyed per user (`<prefix>:<userId>:<sessionId>`), so a chat can never be read or overwritten by a different user. Every method takes a single object; `userId`/`sessionId` are required, validated non-empty, and rejected if they contain the `:` key separator (which would otherwise let keys collide across users).
- `AgentMemory` requires a non-empty `userId` on every call (no silent shared bucket) and rejects a `:` in `userId`; `add`/`recall` take a single object param.
- `ToolCache` keys are `<prefix>:<userId>:<toolName>:<hash>` — scoped per user, then per tool; `userId`/`toolName` are rejected if they contain `:`.
- `createRateLimit`/`createRateLimitAuth` require an explicit `limiter` (removed `limit`/`window`); eve's `createRateLimitAuth` requires `identifier` (no implicit global bucket) and counts only `POST` requests, so a turn (a message `POST` plus its follow-up stream `GET`) is charged once, not twice.
- The eve sandbox denies network egress by default. Its `upstash()` backend config is now the `@upstash/box` `BoxConfig` passed through verbatim (`runtime`/`size`/`apiKey`/`keepAlive`/`initCommand`/`env`/`skills`/…) plus an optional `redis`/`templatePrefix` — the invented `resources.vcpus` hint and runtime-string coercion (`"node24"`) are removed (use `runtime`/`size` as Box expects), and `networkPolicy` is no longer a config knob (egress is governed by the deny-all default plus per-session `use({ networkPolicy })`).
- The eve sandbox now reuses prewarmed Box snapshots correctly: the `templateKey → snapshotId` map is stored in a durable Redis registry (Box has no static snapshot lookup, and `prewarm`/`create` run in different processes), so `create` restores the prewarmed template instead of spinning a fresh, empty box. `prewarm` builds no box when there's nothing to bake. It also bridges Eve's `/workspace` root to Box's `/workspace/home` working directory in both file ops and raw commands, so the agent's `find`/`grep`/file tools hit the right directory.

**Reactive search index**

- New `ReactiveSearchIndex` provisions the Upstash index on the first read (`query`/`aggregate`/`count`) via `existsOk` + retry; writes go straight to Redis, so features never create the index on the write path. Replaces the internal `withIndex` helper.

**API naming (consistent across features)**

- `prefix` — base key prefix (was `namespace`).
- `indexName` — explicit Redis Search index name, separate from `prefix` (was `name`).
- `userId` — per-call tenant scope for memory/tools (was the per-call `namespace`).
- `toolName` — per-tool cache segment.

**Removed**

- The `Rag` primitive — use the schema-driven search tools (`createSearchToolDefs`/`createSearchTools`/`defineSearchTools`) over your own documents instead.
- `search-index.ts`/`RedisSearchIndex` (folded into `AgentMemory` + `ReactiveSearchIndex`).
- ai-sdk singular `cachedTool` — use `cachedTools(map, { userId })` (the tool name comes from the map key).
- `ChatHistory.createChat`/`setTitle`, the unused `metadata` field on `ChatRecord`/`MemoryRecord`, and the `@upstash/agentkit-sdk/testing` (`MockModel`) subpath.

**Other**

- `Ratelimit` + `Duration` are re-exported from every package, so you never import or install `@upstash/ratelimit` directly.
- Bumped the eve peer to `^0.13.1`.
