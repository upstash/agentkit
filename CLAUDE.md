# redis-agentkit — agent guide

AgentKit primitives for building AI agents on **Upstash Redis**, as a pnpm monorepo. Read this before
starting work; it captures the non-obvious decisions and gotchas that aren't visible from the code.

## The one core principle

**Everything runs on Upstash Redis. No vector database, ever.** All "semantic"/similarity features use
**Upstash Redis Search** with the **`$smart` fuzzy operator** — via `@upstash/redis`'s `redis.search`
API, **not** RediSearch `FT.*` and **not** `@upstash/vector`. Matching is lexical/fuzzy (BM25), not
embeddings — keep that in mind when naming/among scoring.

## Packages

| Package | What it is |
| --- | --- |
| `@upstash/agentkit-sdk` (`packages/sdk`) | Core, framework-agnostic primitives. **No `ai` dependency** (redis-only). |
| `@upstash/agentkit-ai-sdk` (`packages/ai-sdk`) | Vercel AI SDK adapter. |
| `@upstash/agentkit-eve` (`packages/eve`) | Eve framework adapter. Depends on the ai-sdk package. |
| `@upstash/agentkit-eve-extension` (`packages/eve-extension`) | AgentKit as a mountable **eve extension** (eve ≥0.24): one `agent/extensions/<ns>.ts` file composes memory tools, search tools, a chat-history hook, and an instructions fragment under `<ns>__*`. |

Examples (`examples/`): `ai-sdk-demo` (hand-written Next.js), `eve-demo` (a real `eve` CLI scaffold),
and `eve-extension-demo` (a minimal eve scaffold that mounts the extension).
`langchain` and `tanstack-ai` packages were **removed** — don't reintroduce them.

### Core SDK exports (`@upstash/agentkit-sdk`)
- `AgentMemory`, `ToolCache`, `ChatHistory`, `createSearchToolDefs` (the framework-agnostic search-tool
  defs — **use these for RAG**, there is no `Rag` primitive), `createRateLimit` (+ `RateLimitConfig`;
  thin `@upstash/ratelimit` factory — `limiter` required), `ReactiveSearchIndex` (+ `ReactiveSearchIndexConfig`/
  `AnySearchSchema`, in `reactive-index.ts`), `s` (schema builder, re-exported from `@upstash/redis`),
  types `ChatRecord`/`ChatSummary`/`ChatSearchHit`, utils `key`/`now`/`stableHash`/`stableStringify`.
  (**Model cache removed**; **`Rag` removed** — RAG is done via the search tools;
  **`search-index.ts`/`RedisSearchIndex` and the `withIndex` helper removed** — `ReactiveSearchIndex`
  replaces them, owning create-on-read.)
- `@upstash/ratelimit` is a **dependency** of core (not a peer); rate limiting lives here now.
- **`ChatHistory`** is durable chat history on **Redis Search** (the source of truth for transcripts,
  resurrecting the old removed ChatHistory). One JSON doc per chat at `agentkit:chat:<userId>:<sessionId>`
  indexed over `userId`+`sessionId` (filters) and `userMessages`+`modelMessages` (`$smart` text); the
  raw `messages` array rides along **unindexed**. **Every method takes a single object**
  with a **required, non-empty `userId`/`sessionId`** (validated; the per-user key is the tenant
  boundary — no cross-user collision possible, so no ownership check). `listChats({userId})` filters by
  user; `searchChats({userId, query, target})` fuzzy-searches user/model text; `saveChat` **replaces**
  the whole array (overwrite, not append — pass the full transcript; typically called server-side in
  the route's `onFinish`). Generic over `TMessage`.
- **Reactive index provisioning** (`withIndex`): a missing Upstash index surfaces differently per op —
  `query`→`null`, `count`→`{count:-1}`, `aggregate`→**throws** a null-`.length` `TypeError` (verified
  against live Redis). `withIndex(provision, op, isMissingResult?)` runs the op, and on a missing index
  (sentinel return or thrown error) creates the index + `waitIndexing()` and retries once. Used by
  `ChatHistory` reads and `ai-sdk` `createSearchTools` (replaced its old proactive ensure).
- **Design rule:** every feature takes only `redis` and **creates/owns its search index internally**,
  exposing the raw handle via `.searchIndex`. Callers never pass a search index in.

### ai-sdk exports
- `createRateLimit` (re-exported from core — call `.limit(id)` before `generateText`, **no model
  wrapper**), `cachedTools`, `createMemoryTools`, `createSearchTools`,
  `createChatHistory` (→ `ChatHistory<UIMessage>`; also re-exports `ChatHistory`/`ChatRecord`/etc.).
  (**No model cache** — removed.)
- **Only `cachedTools`** (no singular `cachedTool` — removed): `cachedTools(map, { userId, redis?, ttlSeconds? })`
  takes a map of `tool()`-built tools (so each keeps inference) and caches each under its **map key as
  the toolName**, scoped to `userId` — so the user never passes a tool name.
- **Self-contained:** users import only from this package. `redis` defaults to `Redis.fromEnv()`; tools
  build their own `ToolCache`/`AgentMemory` internally. No `@upstash/agentkit-sdk` import required by users.

### eve exports
- `.` → `defineCachedTool`, `defineMemoryRecallTool`, `defineMemorySaveTool`, `defineSearchTools`
  (eve counterpart to ai-sdk `createSearchTools` — returns a `{search,aggregate,count}` record of
  `defineTool`-branded tools; call it in each `agent/tools/*.ts` and export one member, repeating
  `schema`+`name` — agent files must be self-contained, see eve-demo specifics),
  **plus** rate limiting: `createRateLimitAuth` (a ready eve route-auth `AuthFn`, `packages/eve/src/auth.ts`)
  and the core `createRateLimit` factory re-exported. **No model wrapper / no `./model` subpath.**
- **No chat history in the eve adapter** — `ChatHistory` is core/ai-sdk only here. eve sessions are
  durable server-side (Vercel Workflow) and `useEveAgent` has no `initialMessages` prop, so a stored
  transcript doesn't round-trip cleanly; resume is via eve's `session` cursor, not us. (The
  **eve-extension** package does capture transcripts to Redis via its `chat_history` hook, and reads
  them back as **tools** — `search_chat_history`/`read_chat_history` — so the model can look up past
  conversations. That's lookup-on-demand, not session resume: the same no-round-trip caveat holds.)
- `./sandbox` → `upstash()` Upstash Box backend. **⚠ INCOMPLETE — see Known issues.**
- Eve is file-centric, but the tool factories now **call `defineTool` internally** and return the
  branded `ToolDefinition` — users export them directly (no outer `defineTool(...)` wrap). Because of
  this, **`eve` is a required (non-optional) peer dep** of `packages/eve`.
- **`defineCachedTool` does not cache streams:** eve ≥0.31 lets executors be async generators
  (preliminary output snapshots), but a cache hit could never replay them — so
  `DefineCachedToolConfig` narrows the **input** `execute` to `Promise<TOutput> | NonStreaming<TOutput>`
  and rejects generator executors at the type level. The `NonStreaming` (`[Symbol.asyncIterator]?: never`)
  intersection is load-bearing: with a plain `Promise<TOutput> | TOutput` union, TS just infers
  `TOutput` *as* the generator object and the rejection silently fails (guarded by a
  `@ts-expect-error` test in `tools.test.ts`). A **runtime backstop** covers JS callers: a directly
  returned `AsyncIterable` throws a `TypeError` before `ToolCache` would serialize the generator
  object into Redis (a *promised* value is just a value — only direct returns are streams, matching
  eve). Factory **returns** stay plain `ToolDefinition` — direct `execute` callers (tests) narrow the
  awaited union themselves.
- Rate limiting in eve = a route-auth gate: `createRateLimitAuth(config)` goes first in
  `eveChannel({ auth: [...] })`; it `.limit()`s, throws `ForbiddenError` (403) over the limit, else
  returns `null` to fall through to the real authenticators (`localDev()`/`vercelOidc()`/…).

### eve-extension (`packages/eve-extension`)
- Built with `eve extension build` (not tsup), on eve ≥0.25's **dist packaging format**: `package.json`
  has `"eve": { "extension": { "source": "./extension", "dist": "./dist/extension" } }`, `files` ships
  **`dist/` only** (compiled `.mjs` + `.d.ts` per contribution, plus `_manifest.json` with
  `builtWithEve`; eve validates compatibility from the manifest), and `eve` is a **floored peer**
  (`">=0.50.0"` — was the scaffold's `"*"` until issue #22; see **Consumer eve version** below). The old 0.24
  format (`"eve": { "extension": "./extension" }`, ships source the consumer recompiles) is rejected by
  eve ≥0.25 with "must declare `eve.extension.dist`" — don't regress to it. **No `prepare` script** (an
  install-time build broke CI: sdk isn't built yet at install; `pnpm build` handles topological order).
- **Consumer requirements** (verified against real `eve init` consumers): none for a bare mount. Apps
  that configure `search` declare `@upstash/redis` themselves — their own mount file imports `s` from
  it, and pnpm's strict layout rejects the phantom dep (npm hoists and hides it). The old "also
  install `@upstash/agentkit-sdk`" workaround is **not** needed on the 0.25 format — the compiled
  dist resolves sdk from the extension's own package.
  (The old eve bug where `eve dev` failed to load an extension installed as a **real directory** —
  npm/yarn hoisted layouts — was fixed upstream in eve 0.25.3; no workaround needed on ≥0.25.3.)
  **Consumer eve version:** `eve extension build` stamps the manifest's `requires` with the building
  eve's *current* contribution-format versions, and a consumer rejects any version not in its own
  supported list — the current dist, built with **eve 0.50.0**, stamps formatVersion 2; extension 1 /
  **tool 24** / **dynamicTool 22** / **hook 17** / instructions 2 / config 1, which needs consumers on
  **eve ≥0.50.0** (0.50.0 is the first — and so far only — eve whose supported lists include
  *both* dynamicTool 22 and hook 17; 0.48.0/0.49.0/0.49.1 accept tool 24 but top out at dynamicTool 21 /
  hook 16, and 0.47.7 tops out at tool 23 / dynamicTool 21 / hook 16). Verified end-to-end, not just from
  the contract tables: the rebuilt extension, packed into a real eve app, builds on eve 0.50.0 and is
  **rejected at install** on eve 0.49.0 (`npm error ERESOLVE … peer eve@">=0.50.0" from
  @upstash/agentkit-eve-extension@0.9.0`). With a too-loose floor it instead installs cleanly and then
  fails `eve build` with
  `Selected module binding "extensions/agentkit.ts" has no compile or runtime usage.` — an incompatible manifest makes the mount contribute nothing, so the error is that obtuse;
  don't expect the old explicit "requires tool contract vN" wording.
  **eve 0.50.0 dropped dynamicTool 21 and hook 16 outright** (both: "Message and reasoning append
  events now expose deltas instead of cumulative snapshots") — a *drop*, not just a bump, so the
  previously published 0.8.0 dist stopped working on 0.50.0 even though its `tool 21` was still
  supported. **Watch every contract in `requires`, not just `tool`** — the last three bumps all moved
  `tool`, which made it easy to assume `tool` is the only axis that matters. It isn't.
  **eve moved the tool contract inside the 0.45 patch line and again twice across 0.47.7 → 0.48.0**,
  so a *patch* bump of the eve devDep can re-stamp the manifest and raise the floor — re-derive it,
  don't assume the minor is enough, and don't assume one release's worth of headroom.
  The `eve` peer is **`">=0.50.0"`, not `"*"`** — issue #22 proved the wildcard is a trap: eve
  0.33 dropped hook contracts ≤9 *nine hours* after 0.32 shipped, so a wildcard install succeeds and
  then fails at `eve build` with a manifest error. The manifest is still the real compatibility tie;
  the peer floor is the install-time guard. **On every eve devDep bump: rebuild, read the new
  `dist/extension/_manifest.json` stamps, find the oldest eve whose `EXTENSION_CAPABILITY_CONTRACTS`
  (in eve's `dist/src/compiler/extension-compatibility.js`) supports them all, and move the peer floor
  to match.**
- `extension/extension.ts` = `defineExtension({ config: zod })`; the default export is the mount factory.
  Config knobs: `userId` (string or `(ctx: SessionContext) => string` — eve's public base of tool+hook
  ctx, imported from `eve/tools`), `redis` (defaults `Redis.fromEnv()`), `memory{topK,minScore}`,
  `search{schema,indexName,prefix,defaultLimit}`, `chatHistory: boolean | {prefix,indexName,ttlSeconds}`
  (**off by default** — enable with `true` or a tuning object).
  Non-JSON config values (`Redis`, functions, the `s` schema) pass through `z.custom` — fine, the mount
  file is evaluated in the runtime.
- Contributions: static tools `recall_memory`/`save_memory`; **dynamic** tools `search`/`search_aggregate`/
  `search_count` (one `defineDynamic` per file, resolved at `session.started` — static modules evaluate at
  discovery where mount config is **not yet bound**, so schema-derived descriptions/input schemas must be
  built in a resolver; unconfigured `search` → resolver returns `null` and the tools don't exist);
  **dynamic** tools `search_chat_history`/`read_chat_history` (same `defineDynamic` reason — they exist
  only when `chatHistory` is enabled, which config binding decides at runtime); hook `chat_history`
  (appends every `message.received`/`message.completed` via core `ChatHistory.getChat`
  + `saveChat`, errors swallowed — a thrown hook fails the turn); `instructions.md` fragment (merges after
  the agent's own instructions). Shared code lives in `extension/lib/runtime.ts` — extensions CAN have
  internal shared modules (unlike agent files).
- **Chat-history tools** (`search_chat_history` = core `searchChats`, `read_chat_history` = `getChat`):
  `userId` is pinned from the session via `resolveUserId(ctx)`, **never** model input — that's the reason
  they're dedicated tools instead of pointing `search` at `agentkit:chat:` (the generic search tool takes
  its filter from the model, so nothing would force a `userId` clause and it would read every tenant's
  transcripts; also `$terms` aggregation fails on that index — text fields aren't FAST). Search returns
  **summaries only** (`sessionId`/`title`/`updatedAt`/`messageCount`/`score`) and **excludes the live
  session** (its text is already in context); read caps at 50 messages with a `truncated` flag. Verified
  end to end against real Redis, incl. cross-tenant isolation (binding config in a probe = set
  `globalThis[Symbol.for("eve.ext-config-scope")]` before importing the built `extension.mjs`, then call
  the mount factory).
- `resolveUserId` defaults `auth.current?.principalId ?? auth.initiator?.principalId ?? session.id` and
  **sanitizes `:` → `_`** (eve principal ids like `eve:app` and session ids would break core key-part
  validation). `sessionId` is sanitized the same way.
- Consumers drop/override slots via a directory mount + `disableTool()` (that's the supported answer for
  "I don't want tool X" — no config flags for it, incl. "capture history but don't let the model read it":
  enable `chatHistory` and `disableTool()` the two history slots). Static memory tools are importable from
  `@upstash/agentkit-eve-extension/tools` for `toolResultFrom`/overrides; the dynamic search and
  chat-history tools are not.
- What an extension **can** contribute (eve ≥0.41, per eve's `docs/extensions.md`): tools, channels,
  connections, skills, schedules, subagents, instruction fragments, hooks — channels, schedules and
  subagents **are** allowed, and a contributed subagent may own its own agent config and sandbox.
  What the extension **root** cannot declare: agent configuration, a sandbox, or nested extensions.
  What stays in `@upstash/agentkit-eve` is therefore a packaging choice, not a framework limit: the
  Box sandbox backend (an extension root can't declare a sandbox), the rate-limit `AuthFn` (you drop
  it into your own channel's `auth` walk), and `defineCachedTool` (wraps user tools).

## Naming history (so you don't resurrect old names)
- ai-sdk caching: `cacheTools` → `cachedTool`+`cachedTools` → now **`cachedTools` only** (singular `cachedTool` removed; toolName = map key, `userId` scopes).
- eve `cachedExecute` → **`defineCachedTool`** (cache key field: `cachePrefix` → `namespace` → **`toolName`**); `recall/saveMemoryTool` → **`defineMemoryRecallTool`/`defineMemorySaveTool`**.
- Memory + memory-tool scoping: `scope` → `namespace` → **`userId`** (string or per-call function).
- **ChatHistory is back** (was removed pending a frontend+backend solution) — now `ChatHistory` on Redis
  Search; Redis is the durable source of truth (eve's Workflow store is pruned 1–30 days after a run
  completes, per Vercel plan, so don't rely on it for long-term history).
- **Removed entirely:** the model cache (`ModelCache`/`SemanticCache`, `cachedModel`, `modelCacheMiddleware`),
  Telemetry, the generic Sandbox (sandbox is eve-only), and dead core exports `ChatMessage`/`Logger`/`noopLogger`.

## API conventions
- **Naming of the knobs (consistent across all features):**
  - `prefix` — the base `agentkit:X` key prefix (config level). `ToolCache`/`AgentMemory`/`ChatHistory`
    configs and `createRateLimit`/`createChatHistory` all use `prefix`.
  - `indexName` — the explicit Redis Search index name, **separate** from `prefix` (defaults to the
    identifier-safe `prefix`): `createSearchToolDefs`/`createSearchTools`/`defineSearchTools`,
    `AgentMemory`, and `ChatHistory` configs.
  - `userId` — the **per-call** value that splits data **under** a prefix (one user's data from
    another's): `AgentMemory.add/recall/forget`, the memory tools, and the `ToolCache` key.
  - `toolName` — the per-call tool segment of the `ToolCache` key (the ai-sdk `cachedTools` map key;
    eve `defineCachedTool`'s `toolName` field).
- `redis` is **optional everywhere** → falls back to `Redis.fromEnv()`. It's the **only** client knob.
- Memory tools: `userId` is **required** — a string (shared if static; avoid in multi-tenant prod) or
  `(input, ctx/options) => string` to derive per-call.
- Cached tools: key is `userId` + `toolName`. ai-sdk **`cachedTools(map, { userId })`** only (toolName =
  map key; no singular `cachedTool`). eve `defineCachedTool({ toolName, userId })`.
- Rate limiting: **`limiter` is required** (e.g. `Ratelimit.slidingWindow(10, "60 s")`) — `limit`/`window`
  were removed. `prefix` is the key prefix; the per-user value is `identifier` (required on eve's
  `createRateLimitAuth`).
- **Reactive index** (`ReactiveSearchIndex`, exported): wraps a `SearchIndex` and provisions it on the
  first **read** (`query`/`aggregate`/`count`) via `existsOk` + retry. Writes (`json.set`) never need
  the index, so features call **no `ensure()` on the write path**. Used by `AgentMemory`/`ChatHistory`/
  `createSearchToolDefs`; it's the type each feature's `.searchIndex` getter returns. (The old
  `withIndex` helper is gone.)
- Key naming: `agentkit:rateLimit:<identifier>`, `agentkit:toolCache:<userId>:<toolName>:<hash>`,
  `agentkit:memory:<userId>:<id>`, `agentkit:chat:<userId>:<sessionId>` (default prefixes shown).
- **Telemetry** (mirrors `@upstash/ratelimit`): every feature that takes a `redis` client tags it via the
  client's hidden `addTelemetry` (protected in `@upstash/redis`, so typed structurally), appending to the
  `Upstash-Telemetry-Sdk` header — e.g.
  `@upstash/redis@1.38.0,@upstash/agentkit-sdk@0.2.0,@upstash/agentkit-ai-sdk@0.2.0`. Core
  `packages/sdk/src/telemetry.ts` exports `addTelemetry(redis, { sdk?, enabled? })` + `SDK_TELEMETRY`
  (both re-exported from the package root); each adapter has its own thin `src/telemetry.ts` passing its
  package tag, so a client carries **both** the core and adapter tags. Dedup is a
  `WeakMap<client, Set<sdk>>` — one tag per (client, sdk) pair, since the client *appends* on every call.
  Opt out: `enableTelemetry: false` on any config (threaded down into the core primitive **and** its
  `ReactiveSearchIndex`), the redis client's own `enableTelemetry`, or `UPSTASH_DISABLE_TELEMETRY`.
  **Testing the header is wire-level, not mock-level:** `@upstash/redis` calls the *global* `fetch`, so
  the `telemetry.test.ts` suites stub `globalThis.fetch`, point a client at a fake URL
  (`responseEncoding: false`, `retry: false`, **`enableAutoPipelining: false`** — auto-pipelining sends a
  batch and expects an *array* body, which breaks a naive stub) and assert on the captured
  `Upstash-Telemetry-Sdk` header; the sdk suite also runs one live-Redis case proving a tagged request is
  still accepted. The eve-extension suite (`packages/eve-extension/test/`) binds mount config the way eve
  does — `globalThis[Symbol.for("eve.ext-config-scope")] = "agentkit"` while importing
  `extension/extension.ts`, then call the mount factory — and tests the **source**, not `dist/`.
  Failures are swallowed — telemetry must never break the client. **Version constants:** each package has a
  committed `version.ts` (`packages/*/src`, extension: `extension/lib/`) written by
  `scripts/sync-version.mjs`, which runs **only at release time** from root `ci:version`
  (`changeset version && node scripts/sync-version.mjs`) so the constant lands in the release PR next to
  the package.json bump. **`build`/`dev` must never regenerate it** — no build step may rewrite tracked
  source (dirty worktrees, watch-mode churn). CI runs the read-only `--check` mode to catch drift. Note the
  installed `@upstash/ratelimit@2.0.8` has **no** `enableTelemetry` option yet — don't pass one to
  `new Ratelimit()`.

## AI SDK version strategy — IMPORTANT
- **AI SDK v7 stable everywhere.** Every package + demo pins `ai` to exactly **`7.0.87`**. `eve` (0.50.0)
  declares `ai` as a **peer** (`^7.0.82`, unchanged since 0.47.6 — neither the 0.47.6 → 0.49.0 nor the
  0.49.0 → 0.50.0 bump moved it), so the apps/packages provide the single copy. Providers:
  `@ai-sdk/openai` `^4.0.53`, `@ai-sdk/provider` `^4.0.9`, `@ai-sdk/react` `^4.0.90` (all stable ranges;
  bump them with `pnpm -r update "@ai-sdk/*"` when eve moves — a stale `@ai-sdk/react` range can pin a
  second, older `ai` copy via its peer resolution, which is exactly the two-copy breakage to avoid).
  (History: the repo was on `7.0.0-beta.178` for `eve@0.13.1`, `7.0.30` for `eve@0.25.2`, then `7.0.58`
  for `eve@0.32.0`–`0.47.3` — the exact pin moves in lockstep with eve's `ai` peer range.)
- **A stale `ai` pin is a hard install failure, not a warning.** eve 0.47.6 raised its `ai` peer
  `^7.0.58` → `^7.0.82`. pnpm only prints `unmet peer ai` in this workspace, but a real **npm**
  consumer on the old exact pin gets `npm error code ERESOLVE … peer ai@"^7.0.82" from eve@0.47.6`
  and cannot install without `--force`/`--legacy-peer-deps`. Treat eve's `ai` peer as a release-blocking
  input on every eve bump; check it with `npm view eve@<v> peerDependencies.ai`.
- The `@ai-sdk/*` bump riding along with `ai` 7.0.87 **collapsed a long-standing second `ai` copy**:
  `@ai-sdk/react@4.0.62` was resolving its own `ai@7.0.59` beside the pinned one (visible on `main` as
  two `ai@…` keys in `pnpm-lock.yaml`). After `pnpm -r update "@ai-sdk/*"` the lockfile has exactly one
  `ai@7.0.87`. Verify with `grep -oE "^  ai@[0-9][^:(]*" pnpm-lock.yaml | sort -u` after any bump.
- **Why exact-pin and not a pnpm `override`:** because everyone lands on the same exact `ai`, pnpm
  installs a single copy. Two copies of `ai` cause type/identity breakage. An override was tried and
  removed as unnecessary — keep it that way unless a dep forces a different `ai@7`.
- **No `pnpm.overrides` in root `package.json`.** Version alignment is the mechanism. (`@types/react` was
  also deduped by aligning `ai-sdk-demo` to `19.2.15`, not by an override.)
- `pnpm-workspace.yaml` sets `minimumReleaseAge: 0` so fresh eve/ai releases aren't gated.
- Two `zod` 4.x copies exist in the lockfile (`@vercel/cli-config`, eve-transitive, wants its own) —
  preexisting and harmless; our packages all resolve one shared zod.
- **v7 type renames to know:** `ToolCallOptions` → **`ToolExecutionOptions<never>`**. v7's
  `LanguageModelMiddleware = Omit<LanguageModelV4Middleware,'specificationVersion'> & { specificationVersion?: string }`
  so middlewares need **no** `specificationVersion` (v6 required `'v3'`, v5 required none — don't add it on v7).

## Testing — IMPORTANT
- **Tests run against a REAL (production) Upstash Redis. Do NOT mock Redis.** Only LLM calls are mocked,
  except the `e2e.test.ts` files which hit **real OpenAI**.
- **Models:** unit/e2e tests use `gpt-4o` (`TEST_MODEL`); READMEs + demos use `gpt-5.4-mini`.
- Each package has `src/test-support.ts`: `hasRedisCreds`, `testRedis()` (`Redis.fromEnv`),
  `uniquePrefix(label)` (colon-separated — key prefixes only), `uniqueUserId(label)` (dash-separated —
  use for **userIds**, which reject `:`), `cleanupKeys(redis, prefix)` — loads repo-root `.env` via
  dotenv. ai-sdk also has `hasOpenAIKey`, `TEST_MODEL`. Suites `describe.skipIf(!hasRedisCreds)` so
  they skip without creds.
- vitest: `fileParallelism: false`, `testTimeout: 30_000`.
- **Upstash DB caps at 10 search indexes** (`ERR Exceeded max index count of 10`). Tests must `drop()` /
  reuse indexes and run sequentially. There is **no** `SEARCH.LIST` command to enumerate them.
- **Throwaway `curl -X POST https://upstash.com/start-redis` databases cap at ONE index**
  (`ERR Exceeded max index count of 1`) — not 10. The suite still passes on one, because
  `fileParallelism: false` means only one index is live at a time, **but the memory suites leave the
  default `agentkit_memory` index behind** (`cleanupKeys` deletes keys, not the index). So the *first*
  `pnpm test` run is green and every later run fails ~21 tests across 5 files with
  `ERR Exceeded max index count of 1` on unrelated `SEARCH.CREATE`s. This is environment exhaustion,
  **not** a regression. Reset before each run:
  `curl -s "$UPSTASH_REDIS_REST_URL" -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" -d '["SEARCH.DROP","agentkit_memory"]'`
  There's no `SEARCH.LIST`, but `SEARCH.DESCRIBE <name>` probes one by name and `SEARCH.DROP <name>`
  removes it — enough to find and clear a stuck index.
- **`packages/eve/src/memory.test.ts > save then recall round-trips` is mildly flaky against live
  Redis** (`expected false to be true` on the "dark mode" recall) — a `waitIndexing()` race, ~1 in 4.
  Re-run the file before believing it; it passed 3/3 in isolation immediately after failing in-suite.
- Without `UPSTASH_BOX_API_KEY` the 6 Box sandbox tests **skip** (not fail); a green run is
  `93 passed | 6 skipped`.
- **Indexing is async, and visibility needs BOTH halves of a rule.** To assert on a search result you
  must satisfy *both*, or the docs may never become visible — not "late", **never**:
  1. **The index must already exist when the doc is written.** A doc written while the index is still
     missing can be dropped by the create-time backfill permanently. Anything relying on the reactive
     create (`ReactiveSearchIndex` provisioning on the first read) to pick up docs seeded *just*
     beforehand is a coin flip.
  2. **`searchIndex.waitIndexing()` must be called after the write**, on that already-existing index.

  Measured against live Redis with a 3-way probe — `provision-then-write-then-wait` returned the full
  result set on the *first* read (0ms); `provision-only` (no post-write wait) and `wait-only` (index
  created after the writes) both sat at 0 hits for the full 10s probe and never recovered. Waiting
  longer does not help: a 25s poll on the old ordering still failed. So order is
  **provision → write → `waitIndexing()` → read**, and `waitIndexing()` on an index that doesn't
  exist yet is a silent no-op, which is the trap.
- **This was the cause of the long-running `Test` flake, and it is fixed.** `packages/sdk/src/
  chat-history.test.ts` ("lists a user's chats" → `expected [ 'c1' ] to include 'c2'`) and
  `packages/eve/src/search-tools.test.ts` ("search runs a $smart query…" → `expected 0 to be greater
  than 0` / `expected 1 to be greater than or equal to 2`) red-lit CI repeatedly, including the
  2026-08-26 nightly on `main` (eve 0.44.3) and three runs of PR #27. Both now provision the index
  before seeding and keep a small `pollUntil` helper as insurance for residual lag; assertions are
  unchanged. **10/10 consecutive green each** after the fix (was 4/10 and 4/10). If either goes red
  again, treat it as a real regression, not noise.
- **The provision-before-seed fix was only applied to those two files.** `packages/ai-sdk/src/
  search-tools.test.ts`, `packages/ai-sdk/src/memory.test.ts`, `packages/eve/src/memory.test.ts` and
  `packages/sdk/src/memory.test.ts` still seed before the index reliably exists, so they flake the same
  way (`expected 0 to be greater than 0`, `recalled[0]` undefined) — measured 2026-09 at roughly 4-in-6
  red **on a one-index throwaway DB**, and confirmed identical on pristine `main`, so it is *not* a
  regression from any dependency bump. On the real 10-index DB the pressure is far lower. Until they
  get the same treatment, verify a suspicious red by `FLUSHDB` -> one warm-up run (which provisions the
  index) -> a second measured run, and always A/B against `git stash` before blaming a bump.
- **Throwaway DBs from `upstash start-redis` (the `@upstash/cli` command; `npm i -g @upstash/cli`)
  cap at *one* search index**, not 10 — `ERR Exceeded max index count of 1`. A single `pnpm test`
  cascades into bogus create-index failures on one. Run **one test file at a time** with a `FLUSHDB`
  between (`curl "$URL" -H "Authorization: Bearer $TOKEN" -d '["FLUSHDB"]'`; FLUSHDB does drop
  indexes, and `SEARCH.DROP <name>` is the only other lever — there is no list command).
- Scores are **BM25 (unbounded)**, not `[0,1]` — `minScore` thresholds are BM25 values.
- `.env` is gitignored — **never commit creds.** Needs `UPSTASH_REDIS_REST_URL`/`_TOKEN`; optionally
  `OPENAI_API_KEY` and `UPSTASH_BOX_API_KEY`.

## Upstash Redis Search quick reference
- Create: `redis.search.createIndex({ name, dataType: "json", prefix, schema })` (idempotent — catch
  "already exists"). Handle: `redis.search.index({ name, schema })` → `.query({filter, limit})`,
  `.aggregate(...)`, `.count(...)`, `.waitIndexing()`, `.describe()`, `.drop()`.
- Write docs as JSON under the prefix: `redis.json.set(prefix + id, "$", {...})`.
- `query` returns `[{ key, score, data }]`.
- Schema via `s`: `s.object({...})`, `s.string()`, `s.number()`, `s.boolean()`, `s.date()`, `s.keyword()`,
  `s.facet()`, `.noTokenize()` (use for filter/tag fields).
- Filter ops: `$smart`, `$phrase`, `$fuzzy`, `$regex`, `$eq`, `$lt/$lte/$gt/$gte`, `$in`, `$range`,
  `$and/$or/$must/$should/$mustNot`. Aggregations: `$terms`, `$stats`, `$sum`, `$avg`, `$min`, `$max`,
  `$count`, `$histogram`, `$percentiles`, `$cardinality`.

## Eve framework facts
- The repo is on **`eve@0.50.0`** everywhere (`packages/eve`, `packages/eve-extension`, `examples/eve-demo`,
  `examples/eve-extension-demo`). `packages/eve`'s peer stays
  **`>=0.32.0`**: the *source* needs eve ≥0.47 to compile (it imports `SandboxDeleteOptions`), but the
  **shipped `dist`** doesn't name any post-0.32 type, and the extra `delete` on the handle is just an
  unused member on older eve — re-verified 2026-08 by typechecking `defineSandbox({ backend: upstash() })`
  against the built `dist` on **20 eve versions from 0.30.8 through 0.47.6** (all clean; re-run 2026-09 on
  the 0.50.0 bump across 0.32.0/0.44.4/0.45.2/0.46.1/0.47.0/0.47.3/0.48.0/0.49.0/0.50.0, also all clean).
  **Judge this floor from the shipped `dist/*.d.ts`, never from `tsc --noEmit` on `src`** — the source
  fails to compile below 0.47 (`'"eve/sandbox"' has no exported member named 'SandboxDeleteOptions'`),
  which looks like a stale floor but isn't: that type is erased from the emitted declarations, so
  consumers on older eve are unaffected. Don't raise the floor without re-running the dist check; the
  extension's peer is `>=0.50.0`, matching its built dist's manifest — see the eve-extension section. Subpath exports:
  `eve/tools`, `eve/hooks`, `eve/extension`, `eve/context`, `eve/instructions`, `eve/sandbox`,
  `eve/sandbox/vercel`, `eve/channels/*`, `eve/next`, `eve/react`, …
- **Breaking changes absorbed on the 0.25 → 0.32 jump:** (a) 0.31 replaced continuation-token session
  APIs with fixed ID-addressed handles — frontend/client `send` is now **positional**
  (`agent.send(message, options?)`, not `send({ message })`; eve-demo's `agent-chat.tsx` was updated);
  (b) `SandboxBackendHandle` gained a required **`stop()`** (authored-runtime stop, errors must reject)
  alongside `shutdown()`; (c) tool executors may return **`AsyncIterable<TOutput>`** (streaming output
  snapshots, 0.31) — `ToolDefinition.execute`'s return type is now a union; `defineCachedTool` rejects
  streaming executors at the type level (see the eve exports section);
  (d) 0.30 changed `localDev()` to grant a deployment-based synthetic principal (runtime `principalId`
  values differ in local dev; our sanitizing `resolveUserId` is unaffected); (e) eve 0.32's `ai` peer is
  `^7.0.58` (drove the repo-wide exact-pin bump). Durable sessions now **complete after 30 days** by
  default (0.28) — strengthens Redis `ChatHistory` as the long-term transcript store.
- **The 0.32 → 0.44.3 jump (issue #22) needed no source changes** — everything compiled and passed
  as-is. Why each headline break missed us: hook contract v10 (0.33, "model identity moved from
  `session.started` runtime metadata to `step.started` call attribution") — our `chat_history` hook
  only reads `message.received`/`message.completed`, whose shapes (incl. `data.finishReason`) are
  unchanged; 0.33's `defineDynamic` narrowing ("accepts only `events`") — our dynamic tools already
  used the events-only form; 0.38 renamed frontend binding `stop()` → `cancel()` — eve-demo never
  called it (`agent.send(message)` positional survives); 0.44.1 reruns session-scoped dynamic
  resolvers on resume ("keep them idempotent") — ours are pure factories. The real fix was
  rebuild + re-stamp the manifest + tighten the peers. `ai` stayed exact-pinned at `7.0.58`
  (eve 0.44's peer is still `^7.0.58`). **One live-dev gotcha:** a demo's `.eve/` dir holding local
  workflow state written by ≤0.37 fails to replay on ≥0.38 ("Event id is not slot-numbered" retry
  loops that wedge new turns — 0.38.2 moved the dev world to slot-numbered event ids). `.eve/` is
  gitignored dev scratch: after an eve bump, `rm -rf examples/*/.eve` before `eve dev`/`next dev`.
  Both demos were verified with live turns on 0.44.3 (memory save + fresh-session recall, search
  count matching seed data, cached weather tool, and the extension's dynamic search + chat-history
  hook/tools writing and reading real `agentkit:chat:demo-user:*` docs); `gpt-5.4-mini` does exist
  and responds — the "may 404" caveat in Known issues didn't materialize.
- **The 0.44.3 → 0.45.0 bump also needed no source changes** — build, typecheck, both demo builds and
  the mocked-model eval all passed unmodified. It was, again, *purely* a manifest/peer-floor move:
  rebuilding on 0.45.0 re-stamps **tool 17→18** and **dynamicTool 18→19**, and 0.45.0 is the first eve
  supporting either, so the extension peer floor went `>=0.43.0` → **`>=0.45.0`** (a 0.45-built dist
  hard-errors at discovery on 0.44.3: *"requires tool contract v18, but this eve supports … v17"*).
  Note the floor is now equal to the pinned version — 0.45 raised both contracts it stamps, so there
  is no back-compat window at all this time. Why 0.45's headline breaks missed us: built-in tool
  definitions moved from `eve/tools/defaults` to per-tool `eve/tools/<name>` subpaths and
  `defineBashTool`/`defineReadFileTool`/`defineWriteFileTool`/`defineGlobTool`/`defineGrepTool` were
  **removed** — we import only `defineTool`/`defineDynamic`/`SessionContext`/`ToolContext`/
  `ToolDefinition` from `eve/tools`, never `eve/tools/defaults` nor any of those factories; and
  `experimental.subagentPersistentSessions` was removed (subagent contract 1 and 2 are now *dropped*,
  only 3 is supported) — we contribute no subagents. `ai` stays exact-pinned at `7.0.58` (eve 0.45's
  peer is still `^7.0.58`).
- **The 0.45.0 → 0.45.2 bump also needed no source changes** — only the manifest re-stamp
  **tool 18→19**, which moves the extension's peer floor `>=0.45.0` → **`>=0.45.1`** (0.45.1 is the
  first eve accepting tool 19). Contribution contracts can move in a *patch* release, so re-derive the
  floor from the freshly built manifest rather than the minor version.
- **The 0.45.2 → 0.47.3 bump was the first one in a while that needed a real source change.**
  eve **0.47.0** made `delete(options?: SandboxDeleteOptions)` a *required* member of
  `SandboxBackendHandle`, so `packages/eve/src/sandbox.ts` failed with `TS2741: Property 'delete' is
  missing …` until the handle implemented it (`box.delete()`, see the sandbox section). Everything
  else was mechanical: no other package changed source, both demos build, and the extension only
  needed a rebuild. The extension manifest went **tool 19→21 / dynamicTool 19→21 / hook 14→16**
  (instructions 2, config 1, extension 1 unchanged), moving its peer floor `>=0.45.1` → **`>=0.47.0`**
  — again floor == pinned minor, no back-compat window. 0.46.1 sits in between (tool 20 / hook 15) and
  is genuinely rejected by the new dist. `packages/eve`'s own peer stayed `>=0.32.0` on purpose (its
  shipped `dist` names no post-0.32 type — see the version bullet at the top of this section).
- **The 0.47.3 → 0.47.6 bump needed no source change, but it moved two pins.** The extension rebuild
  re-stamped **tool 21→22** only (dynamicTool 21, hook 16, instructions 2, config 1, extension 1 all
  unchanged), moving its peer floor `>=0.47.0` → **`>=0.47.5`** — 0.47.5 is the first eve accepting
  tool 22, and **0.47.4 was never published**, so the floor names a version that exists while the one
  below it in the range does not. Proven by `pnpm pack`ing the rebuilt dist into a real eve consumer:
  0.47.0–0.47.3 install cleanly and then fail `eve build` with the same obtuse *"has no compile or
  runtime usage"* message; 0.47.5/0.47.6 build and mount every contribution. Separately, eve 0.47.6
  raised its `ai` peer to `^7.0.82`, so the repo-wide `ai` pin went `7.0.58` → **`7.0.87`** and
  `@ai-sdk/*` moved with it (see the AI SDK section — that bump also de-duplicated `ai`).
  `packages/eve`'s peer stayed **`>=0.32.0`**, re-verified this round by typechecking its built `dist`
  against **20 eve versions, 0.30.8–0.47.6** (all clean): the dist names only `defineTool` and
  `ForbiddenError` at runtime plus five `eve/sandbox` types in its `.d.ts` — `SandboxDeleteOptions` is
  source-only and fully erased from the artifact. Unlike the extension, `packages/eve` has **no
  generated manifest** (plain tsup) and its `dist` is byte-identical whether built against 0.47.3 or
  0.47.6, so an eve bump can never silently move its floor.
- **The 0.47.6 → 0.49.0 bump needed no source change, and moved only the extension's floor.** The
  extension rebuild re-stamped **tool 22→24** only (dynamicTool 21, hook 16, instructions 2, config 1,
  extension 1 all unchanged), moving its peer floor `>=0.47.5` → **`>=0.48.0`**. The important lesson:
  **the tool contract moved twice inside three releases** — 22→23 in **0.47.7** and 23→24 in
  **0.48.0** — so "the next patch is probably fine" is wrong; 0.47.7 is rejected by the 0.49.0-built
  dist just like 0.47.5/0.47.6 are. Proven by `pnpm pack`ing the rebuilt dist into a real eve consumer:
  0.47.5 / 0.47.6 / 0.47.7 install cleanly (the old `>=0.47.5` peer admits all three) and then fail
  `eve build` with the same obtuse *"has no compile or runtime usage"* message; 0.48.0 and 0.49.0 build
  and mount every contribution. Note this **supersedes the unreleased 0.47.6 rebuild** (PR #31/#32,
  `.changeset/eve-extension-0476-rebuild.md`, tool 22 / floor `>=0.47.5`): that changeset was folded
  into `.changeset/eve-extension-0490-rebuild.md` rather than sitting beside it, and the merged entry
  is written against the last **published** state — `0.8.0`, built with eve 0.47.3, tool 21, peer
  `>=0.47.0`. eve's `ai` peer stayed `^7.0.82` and its `nitro` dep stayed `3.0.260610-beta`, so the
  repo-wide `ai` 7.0.87 pin did not move. `packages/eve`'s peer stayed **`>=0.32.0`**, re-verified by
  typechecking its built `dist` against 0.32.0/0.44.3/0.45.2/0.47.0/0.47.3/0.47.6/0.47.7/0.48.0/0.49.0
  (all clean); eve's `dist/src/shared/sandbox-backend.d.ts` is **byte-identical** between 0.47.6 and
  0.49.0, so `SandboxBackendHandle` gained no new required member.
- **The 0.49.0 → 0.50.0 bump needed no source change, and is the first one where `tool` was NOT the
  contract that moved.** eve 0.50.0 **dropped** `dynamicTool` 21 and `hook` 16 (both: *"Message and
  reasoning append events now expose deltas instead of cumulative snapshots"*) and made 22 / 17 current.
  `tool` stayed at 24. The extension rebuild re-stamped **dynamicTool 21→22** and **hook 16→17** (tool 24,
  instructions 2, config 1, extension 1 all unchanged), moving its peer floor `>=0.48.0` → **`>=0.50.0`**;
  0.50.0 is the first *and only* eve accepting that set. The lesson that cost the most here: **three
  consecutive bumps all moved `tool`, which trained the habit of reading only the tool number.** This one
  broke on the two contracts nobody was watching — the published 0.8.0 dist (tool 21, still supported)
  was rejected by 0.50.0 purely on dynamicTool/hook. Always run
  `findUnsupportedExtensionCapabilities()` over the whole `requires` block.
  This also means the **published 0.8.0 is broken on eve 0.50.0 today**, and the unreleased 0.49.0-built
  rebuild would have shipped broken too (same dynamicTool 21 / hook 16) — which is why
  `.changeset/eve-extension-0490-rebuild.md` was rewritten in place against the last *published* state
  (0.8.0, eve 0.47.3, tool 21, peer `>=0.47.0`) rather than layering a second changeset.
  eve's `ai` peer stayed `^7.0.82`, so the repo-wide `ai` 7.0.87 pin did not move. `packages/eve`'s peer
  stayed **`>=0.32.0`** (dist re-verified clean on 0.32.0→0.50.0) and its **published output is unchanged**,
  so it gets **no changeset entry** — only its `eve` devDep moved.
- **Extension packaging changed 0.24 → 0.25**: 0.24 shipped source the consumer recompiles; 0.25 ships
  prebuilt `dist/extension` + `_manifest.json` (see the eve-extension section). 0.25 rejects
  0.24-format packages at discovery.
- **Import eve's real types — do NOT hand-roll them.** From `eve/tools`: `defineTool`, `defineDynamic`,
  `disableTool`, `toolResultFrom`, `ToolDefinition`, `ToolContext`, **`SessionContext`** (base of tool
  + hook ctx — use it for per-call `userId` fns). From `eve/hooks`: `defineHook`, `HookContext`. From
  `eve/extension`: `defineExtension`. From `eve/sandbox`: `defineSandbox`, `SandboxBackend`,
  `SandboxSession`, `SandboxNetworkPolicy`, etc. (`eve` is a devDep of `packages/eve` for these types.)
- `ToolDefinition<TInput,TOutput>` = `{ description, inputSchema, execute(input, ctx: ToolContext), … }`.
- **Extensions** (eve ≥0.24): agent-shaped packages mounted under `agent/extensions/<ns>.ts`; contributions
  compose as `<ns>__<name>`. They may contribute tools, channels, connections, skills, schedules,
  subagents, hooks and instruction fragments (eve ≥0.41; channels keep their declared route paths and
  schedules their cron expressions). The extension **root** cannot declare agent configuration, a
  sandbox, or nested extensions — but a contributed subagent may own its own config and sandbox.
  Config binds at runtime (mount evaluation), not at discovery.
  Hooks are observe-only (can't inject context or short-circuit); a thrown hook fails the turn.
- Stream events for transcripts: `message.received` (`data.message`: flattened user text) and
  `message.completed` (`data.message: string | null`, fires multiple times per turn — interim text before
  tool calls; `data.finishReason` tells terminal from narration).
- Eve uses AI SDK **v7** models, which is why the repo standardized on v7 (so eve can keep depending on
  the ai-sdk package instead of duplicating middleware).
- The real `SandboxBackend` is **two-phase**: `{ name, create(input) → SandboxBackendHandle, prewarm(input)
  → { reused } }`. `SandboxSession` = the AI SDK `Experimental_SandboxSession` (`run`, `spawn`,
  `readFile`→stream, `readBinaryFile`, `readTextFile`, `writeFile`/`writeBinaryFile`/`writeTextFile`) plus
  `id`, `resolvePath`, `setNetworkPolicy`, `removePath`. The handle's lifecycle methods are
  **`stop()`** (eve ≥0.32: authored code ends sandbox work early via `ctx.getSandbox().stop()`; must
  keep the session reattachable and **reject** on provider errors), **`shutdown()`** (server
  shutdown; best-effort, failures collected/logged by eve) and — since **eve 0.47.0** — a required
  **`delete(options?: SandboxDeleteOptions)`** (authored `ctx.getSandbox().delete()`; permanently
  destroy the sandbox + its *disposable* state, **preserve reusable/template state**; errors reject and
  eve then keeps the reconnect state so the caller can retry). The old per-open `dispose()` is gone.
  `SandboxDeleteOptions` (`{ readonly abortSignal?: AbortSignal }`) is exported from `eve/sandbox`;
  neither it nor `delete` exists in eve ≤0.46.1, so `packages/eve` **source** now needs eve ≥0.47 to
  compile. After a successful `delete`, eve drops its own handle reference but leaves the handle in the
  process-wide active-handles map, so `shutdown()` can still be called on a deleted sandbox.

## @upstash/box (sandbox backend)
- Optional peer dep of the eve package. `Box.create({ apiKey | UPSTASH_BOX_API_KEY, runtime, size, … })`;
  `box.exec.command(cmd) → { result, exitCode }`, `box.files.read/write`, `box.getPublicURL(port)`,
  `box.updateNetworkPolicy(...)`, `box.pause()/delete()`. **`pause()` = release compute, keep the box
  reattachable via `Box.get(id)`; `delete()` = permanent teardown of the box** — that pair is exactly
  eve's `stop`/`shutdown` vs `delete` split. Snapshots outlive the box they were taken from (`prewarm`
  snapshots a template box then deletes it), so deleting a box never touches template snapshots.
- Snapshots (for eve templates): `box.snapshot()`, `Box.fromSnapshot(id)`, `box.listSnapshots()`,
  `box.deleteSnapshot(id)`. Runtimes: node|python|golang|ruby|rust.

## examples/eve-demo specifics
- It's a **real `eve` CLI scaffold**, a workspace member — not a hand-written demo. Treat its generated
  `agent/`, `app/`, `components/` as scaffold code.
- Its `AGENTS.md` says: **read `node_modules/eve/docs/` before writing eve agent code.**
- **Every `agent/` file must be self-contained.** eve's dev-runtime snapshot resolves only **package**
  imports from each tool/channel/hook file — it does **not** include shared `agent/`-source modules
  (a shared `agent/redis.ts` *or* `agent/lib/*` both fail with `Cannot find module …` at the turn step).
  So: no relative imports of other agent files; rely on `redis` defaulting to `Redis.fromEnv()` (every
  helper, incl. `createRateLimitAuth`, defaults it — omit it). Search tools repeat their `schema`+`name`
  per file. App-only shared code (e.g. the books seeder a page calls) lives in the project `lib/`, not
  `agent/`. (This is why the README's old "build once in `agent/lib/`" search-tools pattern was changed.)
- `engines.node: 24.x` → CI (Node 24) is clean; local Node 20 only warns. It still builds on 20.
- Keep `ai-sdk-demo`'s `@types/react` pinned to `19.2.15` (and `react` 19.2.6) to match eve-demo and avoid
  a duplicate `@types/react` (causes a JSX `key` "unique symbol" type clash in eve-demo's build).

## examples/eve-extension-demo specifics
- A minimal `eve` CLI scaffold (agent + eve channel, no frontend) whose whole point is the one mount
  file `agent/extensions/agentkit.ts`. Model: `openai("gpt-5.4-mini")`.
- Its mount reuses **eve-demo's** books index (`eve-demo-books`, same schema) — the DB caps at 10 search
  indexes, so the demos share; seed data comes from eve-demo's `lib/books.ts` seeder.
- Needs a local `.env` (gitignored) with the Upstash + OpenAI creds — `eve dev` reads the project dir,
  not the repo root.
- The extension demo's `userId` is the static `"demo-user"` so memory persists across sessions in an
  unauthenticated local agent (the default derivation would fall back to the per-session id).

## Commands
- **Setup gotcha — use pnpm 11.5.3, matching the `packageManager` pin.** Root `package.json` pins
  `"packageManager": "pnpm@11.5.3"`. On a box whose global pnpm is a different version (and no
  corepack), *every* pnpm command dies with
  `ERROR Failed to switch pnpm to v11.5.3. Looks like pnpm CLI is missing at ".../pnpm/11.5.3/bin" …
  spawnSync … ENOENT`. **Install the pinned version rather than working around it:**
  ```bash
  npm i -g pnpm@11.5.3                  # or, to a local prefix: npm i -g pnpm@11.5.3 --prefix /tmp/pnpm11
  ```
  The escape hatch `pnpm config set manage-package-manager-versions false --global` *does* let an older
  pnpm run, but **don't ship a lockfile written by it**: pnpm 10.x rewrites `pnpm-lock.yaml` dropping
  ~51 `libc: [glibc|musl]` fields (huge spurious diff, and CI's `--frozen-lockfile` on pnpm 11 will
  disagree) and it ignores `pnpm-workspace.yaml`'s `allowBuilds`, printing
  `Ignored build scripts: esbuild, sharp.`
- Non-interactive shells: `pnpm install` can abort with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`
  when it wants to purge `node_modules`. Prefix with `CI=true` — but note `CI=true` also implies
  `--frozen-lockfile`, so a *deliberate* dependency bump needs
  `CI=true pnpm install --no-frozen-lockfile`.
- Node also warns `Unsupported engine: wanted {"node":"24.x"}` on newer Node — harmless, everything
  builds and tests fine.
```bash
pnpm build        # tsup (ESM + dts) all packages
pnpm typecheck    # builds the sdk first, then tsc --noEmit across packages
pnpm lint         # eslint + prettier (*.md is prettier-ignored)
pnpm test         # vitest run (against real Redis)
pnpm -r --filter "./examples/*" build   # build both demo apps
```
- CI: Node 24 + pnpm 11; runs lint → typecheck → build → test → example builds.
- Releases use **Changesets**: `pnpm changeset`, `pnpm ci:version`, `pnpm ci:publish`. Do **not** use
  `pnpm version`/`pnpm release` (they collide with built-in pnpm commands).
  **Keep one pending changeset per package, describing the final state.** `.changeset/` accumulates
  across PRs, so a bump that supersedes an *unreleased* changeset already on `main` (e.g. an eve
  version bump re-stamping the extension manifest and floor a second time) must **fold** it in, not sit
  beside it — two entries with contradictory peer floors would both land in the same CHANGELOG. Write
  the merged entry against the last **published** version (`npm view <pkg> version peerDependencies`
  + the package CHANGELOG), not against the intermediate that never shipped. `npx changeset status`
  shows what the pending set resolves to.
- Conventional commits; use `!` for breaking changes. Commit at meaningful checkpoints.

## TODO (current task)
> **Historical log — superseded naming.** The items below record a completed task and use the
> intermediate `namespace` name, which was later renamed to **`userId`** (the per-call tenant value)
> plus **`toolName`** (the cache's tool segment). For the live key naming and conventions, see the
> "API conventions" section above — not this checklist.
- [x] Remove model cache (code + examples done; READMEs pending below).
- [x] ai-sdk: add `cachedTools` (map of `tool()`-built tools, namespace defaults to map key) alongside `cachedTool`; `cachePrefix` → `namespace`; dropped `toolCache` from the config.
- [x] `cachedTool`/`cachedTools` are fully type-safe (config extends the AI SDK `tool()` type — input/output inference, no `any`).
- [x] Search tools: ensure the index (create + `waitIndexing`, memoized) before running each tool — a missing Upstash index returns `null`/`-1` rather than throwing, so we ensure up front.
- [x] `createMemoryTools` (ai-sdk) + eve memory tools: `scope` → `namespace` (string or per-call function). Core `AgentMemory` add/recall/forget use `namespace`.
- [x] Rate limiting: `namespace` is a plain string; prefix `agentkit:rateLimit`.
- [x] Key naming (now `userId`/`toolName`, not `namespace`): `agentkit:rateLimit:<identifier>`, `agentkit:toolCache:<userId>:<toolName>:<hash>`, `agentkit:memory:<userId>:<id>`.
- [x] Unit/e2e tests use `gpt-4o` (`TEST_MODEL`).
- [x] eve: dropped the `./model` subpath — model wrappers are exported from the package root.
- [x] ai-sdk example app fleshed out (memory + search + cached tool + rate limit).
- [x] READMEs (root + 3 packages): feature order = agent memory, search tools, sandbox (eve only), tool cache, rate limiting; never show `wrapLanguageModel`; all method options with inline `optional:` comments; cached-tool snippet imports `generateText` + a prompt; model cache removed; `gpt-5.4-mini`; reflect `namespace`/`cachedTools`/no-`./model`.
- [x] Flesh out the eve + ai-sdk example apps with all features.
- [x] eve `./sandbox` rewritten as a class implementing eve's real two-phase `SandboxBackend` (types imported from `eve/sandbox`); typechecks against eve and the live-Box test passes.

## Known issues / TODO
- **eve `./sandbox` — now the real backend.** `packages/eve/src/sandbox.ts` exports `UpstashSandboxBackend`
  (via the `upstash()` factory), a class implementing eve's real two-phase `SandboxBackend<BO, SO>`
  (`name`/`prewarm`/`create`). All sandbox types are imported from `eve/sandbox` (not hand-rolled).
  Mapping: `prewarm`→ seed files + `bootstrap` then `box.snapshot()` (cached in an in-memory
  `templateKey`→snapshotId map on the instance — use the factory form of `backend` to keep it warm);
  `create`→`Box.fromSnapshot` (or fresh `Box.create`), returning a `SandboxBackendHandle` whose
  `session` is a full `SandboxSession` built over Box (run/spawn/read*/write*/setNetworkPolicy/removePath).
  Typechecks against eve and the offline + live-Box `sandbox.test.ts` pass. `spawn` runs to completion
  then replays output as streams (Box has no detached-process primitive). Config is **`UpstashBackendConfig
  = Omit<BoxConfig, "networkPolicy"> & { redis?, templatePrefix? }`** — the real `@upstash/box` `BoxConfig`
  passed through verbatim (`runtime`/`size`/`apiKey`/`keepAlive`/`initCommand`/`env`/`skills`/…), **no**
  invented `resources.vcpus` hint or runtime-string coercion. `networkPolicy` is intentionally excluded:
  egress is enforced deny-all at creation (in `boxConfig()`) and opened only per-session via Eve's
  `use({ networkPolicy })`. **Template registry:** `prewarm` (build/startup) and `create` (per request)
  run in different processes, so the `templateKey → snapshotId` map lives in a **durable Redis registry**
  (`agentkit:sandbox:template:<name>:<templateKey>`, `redis` defaults to `Redis.fromEnv()`) — an in-memory
  map orphaned the prewarmed box (the old "two boxes, first unused" bug) and Box has no static snapshot
  lookup. `prewarm` builds **no** box when there's nothing to bake (no seed files/bootstrap). **Session
  reuse:** `create` reattaches to the box from `input.existingMetadata.boxId` (`Box.get`) — Eve re-opens a
  session many times and hands our captured `boxId` back, so without this every open spun a fresh box (the
  "3 boxes per turn" bug). Lifecycle: `stop()` (eve ≥0.32, authored `ctx.getSandbox().stop()`)
  `box.pause()`s and **propagates** failures (the contract says provider errors must reject — keep-alive
  boxes can't pause and will reject); `shutdown` (server stop) is the same pause but failure-tolerated.
  Both leave the box reattachable. **`delete(options?)`** (eve ≥0.47, authored `ctx.getSandbox().delete()`)
  is the opposite: it calls **`box.delete()`** — Box's permanent teardown — and *nothing else*. It must
  **not** `deleteSnapshot` or `del` the Redis template registry entry: that's the reusable template state
  eve provisions the session's replacement box from. Errors reject (eve keeps the reconnect state for a
  retry); `options.abortSignal` is honoured with `throwIfAborted()` before the call, since Box's API takes
  no signal. A `deleted` flag makes a second `delete`/`stop`/`shutdown` a no-op — eve keeps deleted
  handles in its active-handles map and pauses them all at server shutdown. `keepAlive` defaults to **false** (pause-based idle; `true` can't be
  paused and runs until deleted). **Path bridge:** Eve roots its tools at `/workspace` but Box sessions live in `/workspace/home`,
  so the backend remaps both `resolvePath` (file ops) and raw commands (`find /workspace …` →
  `/workspace/home`, URL-safe via lookbehind) through the exported `toBoxPath`/`rewriteWorkspacePaths`.
- ~~`gpt-5.4-mini` (demo model) may not exist~~ — verified live (2026-08): it exists and responds in
  both demos. No swap needed.
- The `19.2.17` `@types/react` may linger as an unpruned orphan in `.pnpm`; harmless (nothing links it).
