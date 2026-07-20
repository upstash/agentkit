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
  **eve-extension** package does capture transcripts to Redis via its `chat_history` hook — write-side
  only, same no-round-trip caveat.)
- `./sandbox` → `upstash()` Upstash Box backend. **⚠ INCOMPLETE — see Known issues.**
- Eve is file-centric, but the tool factories now **call `defineTool` internally** and return the
  branded `ToolDefinition` — users export them directly (no outer `defineTool(...)` wrap). Because of
  this, **`eve` is a required (non-optional) peer dep** of `packages/eve`.
- Rate limiting in eve = a route-auth gate: `createRateLimitAuth(config)` goes first in
  `eveChannel({ auth: [...] })`; it `.limit()`s, throws `ForbiddenError` (403) over the limit, else
  returns `null` to fall through to the real authenticators (`localDev()`/`vercelOidc()`/…).

### eve-extension (`packages/eve-extension`)
- Built with `eve extension build` (not tsup); `package.json` has `"eve": { "extension": "./extension" }`,
  `eve` is a **peer** (`^0.24.6`), and `files` ships both `extension/` (source the consumer recompiles)
  and `dist/` (mount factory + `./tools` re-exports). `prepare` runs the build on install.
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
  hook `chat_history` (appends every `message.received`/`message.completed` via core `ChatHistory.getChat`
  + `saveChat`, errors swallowed — a thrown hook fails the turn); `instructions.md` fragment (merges after
  the agent's own instructions). Shared code lives in `extension/lib/runtime.ts` — extensions CAN have
  internal shared modules (unlike agent files).
- `resolveUserId` defaults `auth.current?.principalId ?? auth.initiator?.principalId ?? session.id` and
  **sanitizes `:` → `_`** (eve principal ids like `eve:app` and session ids would break core key-part
  validation). `sessionId` is sanitized the same way.
- Consumers drop/override slots via a directory mount + `disableTool()` (that's the supported answer for
  "I don't want tool X" — no config flags for it). Static memory tools are importable from
  `@upstash/agentkit-eve-extension/tools` for `toolResultFrom`/overrides; dynamic search tools are not.
- What an extension **cannot** contribute (stays in `@upstash/agentkit-eve`): sandbox, channels/auth
  (rate limiting), schedules, agent config. `defineCachedTool` also stays there (wraps user tools).

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

## AI SDK version strategy — IMPORTANT
- **AI SDK v7 stable everywhere.** Every package + demo pins `ai` to exactly **`7.0.30`**. `eve@0.24.x`
  now declares `ai` as a **peer** (`^7.0.26`), so the apps/packages provide the single copy. Providers:
  `@ai-sdk/openai` `^4.0.15`, `@ai-sdk/provider` `^4.0.3`, `@ai-sdk/react` `^4.0.33` (all stable).
  (History: the repo was on `7.0.0-beta.178`, the exact version `eve@0.13.1` depended on.)
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
- **Indexing is async.** After writing (`redis.json.set`), call `searchIndex.waitIndexing()` before
  reading/asserting. Demos do the same.
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
- The repo is on **`eve@0.24.6`** (peer `>=0.24.0` in `packages/eve`, `^0.24.6` in the extension).
  Subpath exports: `eve/tools`, `eve/hooks`, `eve/extension`, `eve/context`, `eve/instructions`,
  `eve/sandbox`, `eve/sandbox/vercel`, `eve/channels/*`, `eve/next`, …
- **Import eve's real types — do NOT hand-roll them.** From `eve/tools`: `defineTool`, `defineDynamic`,
  `disableTool`, `toolResultFrom`, `ToolDefinition`, `ToolContext`, **`SessionContext`** (base of tool
  + hook ctx — use it for per-call `userId` fns). From `eve/hooks`: `defineHook`, `HookContext`. From
  `eve/extension`: `defineExtension`. From `eve/sandbox`: `defineSandbox`, `SandboxBackend`,
  `SandboxSession`, `SandboxNetworkPolicy`, etc. (`eve` is a devDep of `packages/eve` for these types.)
- `ToolDefinition<TInput,TOutput>` = `{ description, inputSchema, execute(input, ctx: ToolContext), … }`.
- **Extensions** (eve ≥0.24): agent-shaped packages mounted under `agent/extensions/<ns>.ts`; contributions
  compose as `<ns>__<name>`. They may contribute tools/connections/skills/hooks/instructions — NOT sandbox,
  channels, schedules, or agent config. Config binds at runtime (mount evaluation), not at discovery.
  Hooks are observe-only (can't inject context or short-circuit); a thrown hook fails the turn.
- Stream events for transcripts: `message.received` (`data.message`: flattened user text) and
  `message.completed` (`data.message: string | null`, fires multiple times per turn — interim text before
  tool calls; `data.finishReason` tells terminal from narration).
- Eve uses AI SDK **v7** models, which is why the repo standardized on v7 (so eve can keep depending on
  the ai-sdk package instead of duplicating middleware).
- The real `SandboxBackend` is **two-phase**: `{ name, create(input) → SandboxBackendHandle, prewarm(input)
  → { reused } }`. `SandboxSession` = the AI SDK `Experimental_SandboxSession` (`run`, `spawn`,
  `readFile`→stream, `readBinaryFile`, `readTextFile`, `writeFile`/`writeBinaryFile`/`writeTextFile`) plus
  `id`, `resolvePath`, `setNetworkPolicy`, `removePath`. In eve ≥0.24 the handle's lifecycle method is
  **`shutdown()`** (fires only on server shutdown; must leave the session reattachable) — the old
  per-open `dispose()` is gone.

## @upstash/box (sandbox backend)
- Optional peer dep of the eve package. `Box.create({ apiKey | UPSTASH_BOX_API_KEY, runtime, size, … })`;
  `box.exec.command(cmd) → { result, exitCode }`, `box.files.read/write`, `box.getPublicURL(port)`,
  `box.updateNetworkPolicy(...)`, `box.pause()/delete()`.
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
  "3 boxes per turn" bug). `shutdown` (eve ≥0.24's replacement for the old per-open `dispose`) fires only
  when the server stops: it `box.pause()`s (reattachable; failure tolerated — keep-alive boxes can't
  pause), and `keepAlive` defaults to **false** (pause-based idle; `true` can't be paused and runs until
  deleted). **Path bridge:** Eve roots its tools at `/workspace` but Box sessions live in `/workspace/home`,
  so the backend remaps both `resolvePath` (file ops) and raw commands (`find /workspace …` →
  `/workspace/home`, URL-safe via lookbehind) through the exported `toBoxPath`/`rewriteWorkspacePaths`.
- `gpt-5.4-mini` (demo model) may not exist → demos build fine but can 404 at runtime. Swap if needed.
- The `19.2.17` `@types/react` may linger as an unpruned orphan in `.pnpm`; harmless (nothing links it).
