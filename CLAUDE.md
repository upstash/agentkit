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

Examples (`examples/`): `ai-sdk-demo` (hand-written Next.js) and `eve-demo` (a real `eve` CLI scaffold).
`langchain` and `tanstack-ai` packages were **removed** — don't reintroduce them.

### Core SDK exports (`@upstash/agentkit-sdk`)
- `AgentMemory`, `ToolCache`, `Rag` + `chunkText`, `s` (schema builder, re-exported from
  `@upstash/redis`), types `FilterValue`/`SearchHit`/`SearchIndexHandle`, utils `key`/`now`/`stableHash`/`stableStringify`.
  (**Model cache removed** — no `ModelCache`.)
- Testing: `@upstash/agentkit-sdk/testing` → `MockModel`.
- **Design rule:** every feature takes only `redis` and **creates/owns its search index internally**,
  exposing the raw handle via `.searchIndex`. Callers never pass a search index in.

### ai-sdk exports
- `rateLimitedModel` / `rateLimitMiddleware` / `RateLimitExceededError`, `cachedTool`, `cachedTools`,
  `createMemoryTools`, `createSearchTools`. (**No model cache** — removed.)
- `cachedTool` config = the AI SDK's `tool()` config (full input/output inference) plus `redis?` /
  `namespace` / `ttlSeconds?` — **no `toolCache`**. `cachedTools(map, { redis?, ttlSeconds? })` takes a
  map of `tool()`-built tools (so each keeps inference) and caches each under its map key.
- **Self-contained:** users import only from this package. `redis` defaults to `Redis.fromEnv()`; tools
  build their own `ToolCache`/`AgentMemory` internally. No `@upstash/agentkit-sdk` import required by users.

### eve exports
- `.` → `defineCachedTool`, `defineMemoryRecallTool`, `defineMemorySaveTool`, **plus** the ai-sdk model
  wrappers (`rateLimitedModel` + rate-limit middleware) re-exported here (no `./model` subpath anymore).
- `./sandbox` → `upstash()` Upstash Box backend. **⚠ INCOMPLETE — see Known issues.**
- Eve is file-centric: factories return `defineTool`-compatible configs the user wraps with `defineTool`.

## Naming history (so you don't resurrect old names)
- ai-sdk `cacheTools(map)` → `cachedTool(single)` → now **`cachedTool` + `cachedTools`**; `cachePrefix` → **`namespace`**.
- eve `cachedExecute` → **`defineCachedTool`** (also `cachePrefix` → **`namespace`**); `recall/saveMemoryTool` → **`defineMemoryRecallTool`/`defineMemorySaveTool`**.
- Memory/eve memory tools: `scope` → **`namespace`** (string or per-call function).
- **Removed entirely:** the model cache (`ModelCache`/`SemanticCache`, `cachedModel`, `modelCacheMiddleware`),
  Telemetry, ChatHistory (needs a frontend+backend solution), the generic Sandbox (sandbox is eve-only),
  and dead core exports `ChatMessage`/`Logger`/`noopLogger`.

## API conventions
- `redis` is **optional everywhere** → falls back to `Redis.fromEnv()`.
- Memory tools: `namespace` is **required** — either a string (memory shared across all users; avoid in
  multi-tenant prod) or `(input, ctx/options) => string` to derive per-call (e.g. a user id).
- Cached tools: `namespace` is the cache key — a string or `(input, ctx/options) => string` (ai-sdk
  `cachedTools` defaults each tool's namespace to its map key).
- Rate limiting: `namespace` is a plain **string** (the key prefix) only; the per-user value is `identifier`.
- Key naming: `agentkit:rateLimit:<identifier>`, `agentkit:toolCache:<namespace>:<hash>`,
  `agentkit:memory:<namespace>:<id>`, `agentkit:rag:<docId>:<chunk>`.

## AI SDK version strategy — IMPORTANT
- **AI SDK v7-beta everywhere.** Every package + demo pins `ai` to exactly **`7.0.0-beta.178`** (the
  version `eve@0.11.7` depends on — it pins an exact version, not a range). Providers: `@ai-sdk/openai`
  and `@ai-sdk/provider` on `^4.0.0-beta`.
- **Why exact-pin and not a pnpm `override`:** because everyone (incl. eve's transitive dep) lands on the
  same exact `ai`, pnpm installs a single copy. Two copies of `ai` cause type/identity breakage. An
  override was tried and removed as unnecessary — keep it that way unless a dep forces a different `ai@7`.
- **No `pnpm.overrides` in root `package.json`.** Version alignment is the mechanism. (`@types/react` was
  also deduped by aligning `ai-sdk-demo` to `19.2.15`, not by an override.)
- `pnpm-workspace.yaml` sets `minimumReleaseAge: 0` so beta installs aren't gated.
- **v7 type renames to know:** `ToolCallOptions` → **`ToolExecutionOptions<never>`**. v7's
  `LanguageModelMiddleware = Omit<LanguageModelV4Middleware,'specificationVersion'> & { specificationVersion?: string }`
  so middlewares need **no** `specificationVersion` (v6 required `'v3'`, v5 required none — don't add it on v7).

## Testing — IMPORTANT
- **Tests run against a REAL (production) Upstash Redis. Do NOT mock Redis.** Only LLM calls are mocked,
  except the `e2e.test.ts` files which hit **real OpenAI**.
- **Models:** unit/e2e tests use `gpt-4o` (`TEST_MODEL`); READMEs + demos use `gpt-5.4-mini`.
- Each package has `src/test-support.ts`: `hasRedisCreds`, `testRedis()` (`Redis.fromEnv`),
  `uniqueNamespace(label)`, `cleanupKeys(redis, ns)` — loads repo-root `.env` via dotenv. ai-sdk also has
  `hasOpenAIKey`, `TEST_MODEL`. Suites `describe.skipIf(!hasRedisCreds)` so they skip without creds.
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
- `eve@0.11.7` is on npm with subpath exports: `eve/tools`, `eve/sandbox`, `eve/sandbox/vercel`, `eve/next`, …
- **Import eve's real types — do NOT hand-roll them.** From `eve/tools`: `defineTool`, `ToolDefinition`,
  `ToolContext`. From `eve/sandbox`: `defineSandbox`, `SandboxBackend`, `SandboxSession`,
  `SandboxNetworkPolicy`, etc. (`eve` is a devDep of `packages/eve` for these type imports.)
- `ToolDefinition<TInput,TOutput>` = `{ description, inputSchema, execute(input, ctx: ToolContext), … }`.
- Eve uses AI SDK **v7** models, which is why the repo standardized on v7 (so eve can keep depending on
  the ai-sdk package instead of duplicating middleware).
- The real `SandboxBackend` is **two-phase**: `{ name, create(input) → SandboxBackendHandle, prewarm(input)
  → { reused } }`. `SandboxSession` = the AI SDK `Experimental_SandboxSession` (`run`, `spawn`,
  `readFile`→stream, `readBinaryFile`, `readTextFile`, `writeFile`/`writeBinaryFile`/`writeTextFile`) plus
  `id`, `resolvePath`, `setNetworkPolicy`, `removePath`.

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
- `engines.node: 24.x` → CI (Node 24) is clean; local Node 20 only warns. It still builds on 20.
- Keep `ai-sdk-demo`'s `@types/react` pinned to `19.2.15` (and `react` 19.2.6) to match eve-demo and avoid
  a duplicate `@types/react` (causes a JSX `key` "unique symbol" type clash in eve-demo's build).

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
- [x] Remove model cache (code + examples done; READMEs pending below).
- [x] ai-sdk: add `cachedTools` (map of `tool()`-built tools, namespace defaults to map key) alongside `cachedTool`; `cachePrefix` → `namespace`; dropped `toolCache` from the config.
- [x] `cachedTool`/`cachedTools` are fully type-safe (config extends the AI SDK `tool()` type — input/output inference, no `any`).
- [x] Search tools: ensure the index (create + `waitIndexing`, memoized) before running each tool — a missing Upstash index returns `null`/`-1` rather than throwing, so we ensure up front.
- [x] `createMemoryTools` (ai-sdk) + eve memory tools: `scope` → `namespace` (string or per-call function). Core `AgentMemory` add/recall/forget use `namespace`.
- [x] Rate limiting: `namespace` is a plain string; prefix `agentkit:rateLimit`.
- [x] Key naming: `agentkit:rateLimit:<identifier>`, `agentkit:toolCache:<namespace>:<hash>`, `agentkit:memory:<namespace>:<id>`, `agentkit:rag:<docId>:<chunk>`.
- [x] Unit/e2e tests use `gpt-4o` (`TEST_MODEL`).
- [x] eve: dropped the `./model` subpath — model wrappers are exported from the package root.
- [x] ai-sdk example app fleshed out (memory + search + cached tool + rate limit).
- [ ] READMEs (root + 3 packages): feature order = agent memory, search tools, sandbox (eve only), tool cache, rate limiting; never show `wrapLanguageModel`; show all method options with inline comments (`optional: ` prefix); cached-tool snippet imports `generateText` + a prompt; remove model cache; use `gpt-5.4-mini`; reflect `namespace`/`cachedTools`/no-`./model`.
- [ ] Flesh out the eve and ai sdk example apps with all features.

## Known issues / TODO
- **eve `./sandbox` is incomplete.** `packages/eve/src/sandbox.ts` still implements an OLD hand-rolled
  interface (`{ providerId, createSession }`) that does **not** match eve's real two-phase `SandboxBackend`
  (`name`/`create`/`prewarm` + full streaming `SandboxSession`). It must be rewritten against eve's real
  types (mapping `prewarm`→Box snapshot, `create`→`Box.fromSnapshot`, and building the full `SandboxSession`
  over Box). Decision on record: implement the **full real backend**. It can be typechecked against eve but
  **not runtime-verified** here (no eve runtime). `eve-demo` does not currently use it.
- `gpt-5.4-mini` (demo model) may not exist → demos build fine but can 404 at runtime. Swap if needed.
- The `19.2.17` `@types/react` may linger as an unpruned orphan in `.pnpm`; harmless (nothing links it).
