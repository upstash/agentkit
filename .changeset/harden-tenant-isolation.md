---
"@upstash/agentkit-sdk": minor
"@upstash/agentkit-ai-sdk": minor
"@upstash/agentkit-eve": minor
---

Tenant-isolation hardening, a type-safe reactive search index, and a consistent `prefix`/`indexName`/`userId`/`toolName` API. Contains breaking changes.

**Tenant isolation**

- `ChatHistory` is keyed per user (`<prefix>:<userId>:<sessionId>`), so a chat can never be read or overwritten by a different user. Every method takes a single object; `userId`/`sessionId` are required and validated non-empty.
- `AgentMemory` requires a non-empty `userId` on every call (no silent shared bucket); `add`/`recall` take a single object param.
- `ToolCache` keys are `<prefix>:<userId>:<toolName>:<hash>` — scoped per user, then per tool.
- `createRateLimit`/`createRateLimitAuth` require an explicit `limiter` (removed `limit`/`window`); eve's `createRateLimitAuth` requires `identifier` (no implicit global bucket).
- The eve sandbox denies network egress by default.

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
