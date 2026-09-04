# @upstash/agentkit-eve

## 0.9.0

### Minor Changes

- 0117c2e: feat(eve): add `@upstash/agentkit-eve/memory` — Upstash Redis behind eve's memory slots

  A new subpath with two integrations for eve's [memory](https://eve.dev/docs/memory) feature
  (`agent/memory/<slot>.ts`), because eve exposes two different seams:

  - **`redisDocuments()`** — a `MemoryDocumentBackend` for eve's built-in `fileMemory()`, replacing its
    Vercel Blob storage: `fileMemory({ backend: redisDocuments() })`. Without a `backend`,
    `fileMemory()` only resolves storage under `eve dev` and on Vercel with a Blob store attached.
  - **`redisMemory()`** — a full `MemoryProvider` over the SDK's `AgentMemory`: ranked BM25 recall at
    `turn.started` / `compaction.completed`, capture at `turn.completed`, and the tools
    `<slot>__save_memory`, `<slot>__search_memory`, `<slot>__read_session` and `<slot>__forget_memory`,
    bound to the slot's locked scope. Where `fileMemory()` replays one curated document, this recalls
    the top-K memories relevant to the current turn and needs no tool call to remember anything.

  Both are additive: `defineMemoryRecallTool` / `defineMemorySaveTool` are unchanged and remain the
  right choice for model-driven memory with no slot.

  **Requirements.** The subpath imports `eve/memory` and `eve/memory/file` (added in eve 0.45.1 and
  0.45.2), so it needs **eve ≥ 0.45.2** — the package's `eve` peer stays `>=0.32.0` because the root
  and `./sandbox` entry points still work further back. The `@upstash/redis` peer floor moves to
  **`>=1.38.4`**, whose read-your-writes fix `redisDocuments()` relies on.

  **`redisMemory()` options:** `rememberMessages` (default `true`, meaning `"fromUser"`; also `"all"`,
  `"fromModel"`, `false`), `maxRecallCharacters` (4000), `maxMemoryCharacters` (2048), plus `topK`,
  `minScore`, `prefix`, `indexName`.

  Three behaviours worth knowing before you configure it:

  - **Automatic recall injects saved facts only.** Captured messages share the store but not the
    ranking, and are reached on demand through `search_memory` / `read_session`. Otherwise a stored
    _"What do you remember?"_ outranks real facts on the next identical question.
  - **`forget_memory` redacts rather than deletes.** The text is erased and the entry marked deleted,
    so it can never be recalled or searched again, but `read_session` renders it as `[redacted]` — a
    silent gap invites re-deriving the very thing that was removed.
  - **`"all"` and `"fromModel"` do not get `forget_memory`.** Those modes store the assistant's
    replies, and a reply confirming a deletion quotes the text it deleted — so erasing something would
    write a fresh copy of it. They contribute `save_memory`, `search_memory` and `read_session` only.

  Everything the slot keeps lives in one keyspace of its own (`agentkit:memorySlot`) with `sessionId`,
  `source` and `deleted` indexed, so there is no separate transcript store to fall out of sync.
  Recalled memories are tagged `session=<id>`, and `read_session` replays that session in order.

### Patch Changes

- Updated dependencies [0117c2e]
  - @upstash/agentkit-sdk@0.9.0
  - @upstash/agentkit-ai-sdk@0.9.0

## 0.8.0

### Minor Changes

- f426c7d: feat(eve/sandbox): implement the `delete()` sandbox-handle method (eve 0.47)

  eve 0.47.0 added a required `delete(options?: SandboxDeleteOptions)` to
  `SandboxBackendHandle`, so the Box-backed handle stopped satisfying the interface
  (`TS2741: Property 'delete' is missing …`). It now implements it: `delete()` calls
  `box.delete()` — Upstash Box's permanent teardown — instead of the `box.pause()`
  that `stop()`/`shutdown()` use to keep the box reattachable. Per eve's contract it
  destroys only _disposable_ state: the prewarmed template snapshot and its Redis
  `templateKey → snapshotId` registry entry are left intact, so eve provisions the
  session's replacement box from the same template. Provider errors reject (eve then
  preserves the reconnect state for a retry), `options.abortSignal` is honoured before
  the call, and a deleted handle turns further `delete`/`stop`/`shutdown` calls into
  no-ops (eve still pauses deleted handles at server shutdown).

  The `eve` devDependency of `packages/eve` moves to `^0.47.3`. The `eve` peer range
  stays `>=0.32.0`: the built `dist` names no post-0.32 type and was re-verified against
  eve 0.32.0 and 0.46.1.

## 0.7.0

### Minor Changes

- 55db7e1: feat!: rebuild against eve 0.44 so the extension loads on current eve (fixes #22)

  `@upstash/agentkit-eve-extension@0.6.0` was built with eve 0.32.0, stamping hook
  contract v9 in its `dist/extension/_manifest.json` — a contract eve 0.33.0
  dropped, so the extension failed `eve build` on every eve released after 0.32.0.

  - The extension is now built with **eve 0.44.3** (manifest: formatVersion 2,
    tool 17 / dynamicTool 18 / hook 14 / instructions 2) and loads on
    **eve ≥ 0.43.0**.
  - The extension's `eve` peer dependency is tightened from `"*"` to
    `">=0.43.0"`, so an incompatible eve now fails at install time with an
    actionable message instead of at `eve build`.
  - `@upstash/agentkit-eve`'s `eve` peer is corrected from `>=0.24.0` to
    `>=0.32.0` — the Upstash Box sandbox backend implements the `stop()` handle
    contract eve requires since 0.32.

  No runtime behavior changed; all sources compile and pass unmodified against
  eve 0.44.3.

## 0.6.0

### Minor Changes

- 5c93af5: feat: report the sdk name + version to Upstash via the redis client's telemetry headers

  Every feature that takes a `redis` client now appends its package tag to the client's
  `Upstash-Telemetry-Sdk` header (e.g.
  `@upstash/redis@1.38.0,@upstash/agentkit-sdk@0.2.0,@upstash/agentkit-ai-sdk@0.2.0`), matching
  `@upstash/ratelimit`. No personal data, keys or identifiers are collected. Opt out with
  `enableTelemetry: false` on any config, with the same option on the redis client, or with the
  `UPSTASH_DISABLE_TELEMETRY` env var.

### Patch Changes

- Updated dependencies [5c93af5]
  - @upstash/agentkit-sdk@0.6.0
  - @upstash/agentkit-ai-sdk@0.6.0

## 0.5.0

### Minor Changes

- b0ef882: Upgrade to eve 0.32 (repo now builds and tests against eve 0.32.0 / AI SDK 7.0.58).

  `@upstash/agentkit-eve`:

  - The Upstash Box sandbox backend implements eve ≥0.32's `SandboxBackendHandle.stop()` (authored
    `ctx.getSandbox().stop()`): pauses the box, keeps the session reattachable, and rejects on provider
    errors per the contract (`shutdown()` stays best-effort).
  - `defineCachedTool` does not cache streams: eve ≥0.31 lets tool executors be async generators
    (streaming preliminary output snapshots), but a cache hit could never replay them —
    `DefineCachedToolConfig` now rejects async-generator executors at the type level (its `execute`
    must resolve to a value), and a runtime `TypeError` backstops untyped JS callers before the
    generator object would be serialized into the cache.

  `@upstash/agentkit-eve-extension`:

  - The prebuilt `dist/extension` is now built with eve 0.32, so its compatibility manifest requires
    eve 0.32's contribution formats — **consumers need eve ≥0.32** to mount this version of the
    extension. (The eve ≥0.25.3 fix for extensions installed as physical `node_modules` directories
    means the old pnpm-only caveat is gone.)

## 0.3.0

### Minor Changes

- 463c788: Add `@upstash/agentkit-eve-extension`: AgentKit as a mountable eve extension (eve ≥0.24). One file in `agent/extensions/` composes memory tools, schema-aware Redis Search tools, an opt-in durable chat-history hook, and a memory instructions fragment under one namespace.

  `@upstash/agentkit-eve` moves to **eve 0.24.6** and **ai 7.0.30** (stable). Breaking: eve ≥0.24 replaced the sandbox backend handle's `dispose()` with `shutdown()` (fires only on server shutdown; the Upstash Box backend now pauses the box), and the `eve` peer range is now `>=0.24.0`.

## 0.2.2

### Patch Changes

- 0970c09: change network policy to open boxes with allow-all network

## 0.2.1

### Patch Changes

- fcc8eb1: Add baseSnapshot parameter to upstash sandbox

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

### Patch Changes

- Updated dependencies [7f706d0]
  - @upstash/agentkit-sdk@0.2.0
  - @upstash/agentkit-ai-sdk@0.2.0

## 0.1.0

### Minor Changes

- 21e402b: Initial release of Redis AgentKit.

  - **@upstash/agentkit-sdk** — core primitives on Upstash Redis: agent memory, semantic cache, tool-call cache, and RAG, with search powered by Upstash Redis Search's `$smart` fuzzy operator (no vector database required).
  - **@upstash/agentkit-ai-sdk** — Vercel AI SDK adapter: semantic-cache + rate-limit model middleware, tool-call caching, and memory / Redis-Search tools.
  - **@upstash/agentkit-eve** — Vercel Eve adapter: cached tools, memory tools, model wrappers, and an Upstash Box code-execution sandbox backend.

### Patch Changes

- Updated dependencies [21e402b]
  - @upstash/agentkit-sdk@0.1.0
  - @upstash/agentkit-ai-sdk@0.1.0
