# @upstash/agentkit-sdk

## 0.9.0

### Minor Changes

- 0117c2e: feat(sdk): typed indexed metadata on `AgentMemory`, plus `get`/`list`/`count`

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

## 0.6.0

### Minor Changes

- 5c93af5: feat: report the sdk name + version to Upstash via the redis client's telemetry headers

  Every feature that takes a `redis` client now appends its package tag to the client's
  `Upstash-Telemetry-Sdk` header (e.g.
  `@upstash/redis@1.38.0,@upstash/agentkit-sdk@0.2.0,@upstash/agentkit-ai-sdk@0.2.0`), matching
  `@upstash/ratelimit`. No personal data, keys or identifiers are collected. Opt out with
  `enableTelemetry: false` on any config, with the same option on the redis client, or with the
  `UPSTASH_DISABLE_TELEMETRY` env var.

## 0.2.0

### Minor Changes

- 7f706d0: Tenant-isolation hardening, a type-safe reactive search index, and a consistent `prefix`/`indexName`/`userId`/`toolName` API. Contains breaking changes.

  **Tenant isolation**

  - `ChatHistory` is keyed per user (`<prefix>:<userId>:<sessionId>`), so a chat can never be read or overwritten by a different user. Every method takes a single object; `userId`/`sessionId` are required, validated non-empty, and rejected if they contain the `:` key separator (which would otherwise let keys collide across users).
  - `AgentMemory` requires a non-empty `userId` on every call (no silent shared bucket) and rejects a `:` in `userId`; `add`/`recall` take a single object param.
  - `ToolCache` keys are `<prefix>:<userId>:<toolName>:<hash>` — scoped per user, then per tool; `userId`/`toolName` are rejected if they contain `:`.
  - `createRateLimit`/`createRateLimitAuth` require an explicit `limiter` (removed `limit`/`window`); eve's `createRateLimitAuth` requires `identifier` (no implicit global bucket) and counts only `POST` requests, so a turn (a message `POST` plus its follow-up stream `GET`) is charged once, not twice.
  - The eve sandbox denies network egress by default. Its `upstash()` backend config is now the `@upstash/box` `BoxConfig` passed through verbatim (`runtime`/`size`/`apiKey`/`keepAlive`/`initCommand`/`env`/`skills`/…) plus an optional `redis`/`templatePrefix` — the invented `resources.vcpus` hint and runtime-string coercion (`"node24"`) are removed (use `runtime`/`size` as Box expects), and `networkPolicy` is no longer a config knob (egress is governed by the deny-all default plus per-session `use({ networkPolicy })`).
  - The eve sandbox now reuses prewarmed Box snapshots correctly: the `templateKey → snapshotId` map is stored in a durable Redis registry (Box has no static snapshot lookup, and `prewarm`/`create` run in different processes), so `create` restores the prewarmed template instead of spinning a fresh, empty box. `prewarm` builds no box when there's nothing to bake. It also bridges Eve's `/workspace` root to Box's `/workspace/home` working directory in both file ops and raw commands, so the agent's `find`/`grep`/file tools hit the right directory.
  - The eve sandbox now reuses one box per conversation instead of creating a new box on every session open: `create` reattaches to the box from `existingMetadata` (Eve re-opens a session many times per turn) and `dispose` no longer tears the box down. `keepAlive` defaults to `false` (Box's pause-based idle lifecycle), so idle boxes are auto-paused/reaped rather than leaked.
  - The eve sandbox no longer silently drops Eve's per-domain network rules. Box's network policy is a plain domain/CIDR allow-list, so a policy carrying `transform` (firewall header injection / credential brokering) or `forwardURL` now **throws** instead of being quietly reduced to a bare allow-list (which would send the request unauthenticated). For credential brokering, set Box's `attachHeaders` at backend creation via `upstash({ attachHeaders })`.
  - `createRateLimit`'s `redis` is now optional and defaults to `Redis.fromEnv()`, matching the "`redis` defaults everywhere" convention — previously it was the one feature that required an explicit client.

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

## 0.1.0

### Minor Changes

- 21e402b: Initial release of Redis AgentKit.

  - **@upstash/agentkit-sdk** — core primitives on Upstash Redis: agent memory, semantic cache, tool-call cache, and RAG, with search powered by Upstash Redis Search's `$smart` fuzzy operator (no vector database required).
  - **@upstash/agentkit-ai-sdk** — Vercel AI SDK adapter: semantic-cache + rate-limit model middleware, tool-call caching, and memory / Redis-Search tools.
  - **@upstash/agentkit-eve** — Vercel Eve adapter: cached tools, memory tools, model wrappers, and an Upstash Box code-execution sandbox backend.
