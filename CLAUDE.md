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
| `@upstash/agentkit-tanstack-ai` (`packages/tanstack-ai`) | TanStack AI backends: persistence stores, `StreamDurability`, `LockStore`, `MemoryAdapter`, middlewares, search tools. |
| `@upstash/agentkit-eve-extension` (`packages/eve-extension`) | AgentKit as a mountable **eve extension** (eve ≥0.24): one `agent/extensions/<ns>.ts` file composes memory tools, search tools, a chat-history hook, and an instructions fragment under `<ns>__*`. |
| `@upstash/mcp-toolkit` (`packages/mcp-toolkit`) | Durable building blocks for the official `@modelcontextprotocol/server` v2: `/tasks` (**long-running MCP tools** — start + `task_status` + `task_cancel`) and `/events` (**MCP Events**, webhook delivery). `/tasks` and `/events` are generic (layers, interfaces, memory backends); every Upstash backend for both is in `/upstash` (no `/tasks/upstash`, no `/events/upstash`). `@upstash/redis`, `@upstash/qstash` and `@upstash/workflow` are regular dependencies (the package "just works"); only `@modelcontextprotocol/server` is a peer. Renamed from `@upstash/mcp-tasks` before its first release. **Not an `agentkit-*` package** — separate name, versioned independently (the changesets `linked` glob only covers `@upstash/agentkit-*`), and it depends on none of the others. |

Examples (`examples/`): `ai-sdk-demo` (hand-written Next.js), `eve-demo` (a real `eve` CLI scaffold),
`eve-extension-demo` (a minimal eve scaffold that mounts the extension), and `mcp-toolkit-demo`
(Next.js; the MCP server plus a browser client that shows the JSON-RPC wire log).
`langchain` was **removed** — don't reintroduce it. A first `tanstack-ai` adapter was removed in June 2026
(it only wrapped memory + a model cache); the current `packages/tanstack-ai` is a different package that
implements TanStack AI's own backend contracts (see its section below) — keep it.

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
- `./sandbox` → `UpstashSandbox`, an Upstash Box sandbox **provider** (eve ≥0.64 `defineSandboxProvider`). See Known issues for the design notes.
- `./memory` → **eve's native memory feature** (`agent/memory/<slot>.ts`), on Redis. Two exports,
  both shipped because they sit at *different* eve seams: `redisDocuments()` is a
  `MemoryDocumentBackend` for eve's own `fileMemory()` (storage only — replaces Vercel Blob, which is
  the documented gap: `fileMemory()` with no `backend` errors outside `eve dev`/Vercel-with-Blob), and
  `redisMemory()` is a **full `MemoryProvider`** over core `AgentMemory` (ranked BM25 recall at
  `turn.started`/`compaction.completed`, automatic capture at `turn.completed`,
  plus `save_memory`/`search_memory`/`read_session`/`forget_memory` tools). See the **eve memory slots** section below.
  This is *additive*: `defineMemoryRecallTool`/`defineMemorySaveTool`, ai-sdk `createMemoryTools` and
  the extension's `recall_memory`/`save_memory` are untouched and still the answer for
  purely model-driven memory with no slot and no eve-version floor.
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
  (`">=0.48.0"` — was the scaffold's `"*"` until issue #22; see **Consumer eve version** below). The old 0.24
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
  supported list — the current dist, built with **eve 0.76.0**, stamps formatVersion 2; extension 1 /
  **tool 84** / **dynamicTool 77** / **hook 43** / instructions 2 / config 1, which needs consumers on
  **eve ≥0.76.0** — 0.76.0 is the first release accepting all three (0.75.0 and 0.75.1 refuse them with the same obtuse "has no compile or runtime usage" error; an intermediate dist built with 0.75.1 stamped 80/75/41 with floor 0.75.0 and was never released; 0.74.0 and earlier refuse these too, e.g. 0.74.0 fails `eve build` with the obtuse "has no compile or runtime usage" error; the previous dist, built with 0.74.0, stamped 78/73/39 with floor 0.74.0 — 0.72.0–0.73.0 refuse those too: a pack of this dist built
  against 0.72.0/0.72.1/0.73.0 fails `eve build` with the obtuse "has no compile or runtime usage" error; the intermediate
  0.72.1 build stamped 76/72/38 with floor 0.72.0 and was never released; 0.72.0 **dropped tool 71–75**; the published dist, built with 0.69.0, stamped
  71/68/35 with floor 0.69.0 and fails on eve ≥0.72.0). Earlier: 0.69.0 was the first release accepting any of 71/68/35 (0.65.0–0.68.0 accept none
  of them), and 0.69.0 in turn **dropped** tool 59 / dynamicTool 56 / hook 29, the stamps of the 0.68.0
  build (published `0.14.0`). The 0.68.0 build stamped tool 59 / dynamicTool 56 / hook 29 (floor
  0.68.0: 0.67.0–0.67.2 accept dynamicTool 56 but neither of the others). The dist before that,
  built with 0.65.0, stamped tool 55 / dynamicTool 52 / hook 25 (floor 0.65.0; the 0.64.1 build stamped
  tool 54), because eve now
  **drops** mid-range contracts rather than only adding new ones (0.64.0's supported `tool` list is
  [1–13, 29–32, 34, 35, 54], its `dynamicTool` list [1–20, 22, 31–33, 52] and its `hook` list
  [10–15, 17–23, 25] — 0.64.0 dropped **tool 53, dynamicTool 51 AND hook 24 in one release**, which is
  exactly the stamp published `0.12.0` carries, so 0.12.0 cannot build on any eve newer than it).
  0.63.0 stamps tool 53 / dynamicTool 51 / hook 24 and rejects tool 54 / dynamicTool 52 / hook 25
  (0.63.0's supported `tool` list is
  [1–13, 29–32, 34, 35, 53] and its `dynamicTool` list [1–20, 22, 31–33, 51]: 36–52 are dropped with
  "experimental_workflow … removed" / "Background defineTool and TaskExec were removed", and dynamicTool 29
  — the stamp published `0.10.0` carries — with "Background dynamic tools were removed").
  0.61.0 stamps tool 51 / dynamicTool 50 / hook 24 and 0.61.1–0.62.0 still reject tool 53 / dynamicTool 51;
  0.55.0 topped out at tool 38 / dynamicTool 37 / hook 22 (its `tool` list was [1–13, 28–32, 34–38]);
  0.54.3–0.54.5 top out at tool 36 (dynamicTool 34 on 0.54.3, 35 on 0.54.4/0.54.5), 0.54.0/0.54.2 at tool 35 /
  dynamicTool 33, 0.53.0/0.53.1 at tool 34 / dynamicTool 32, 0.52.3 at tool 32 / dynamicTool 31,
  0.52.2 at tool 30 / dynamicTool 29 / hook 20, 0.52.1/0.52.0 at tool 29, 0.51.1 at tool 27 / dynamicTool 27 / hook 20, 0.51.0 at tool 25 /
  hook 18, 0.50.0 at dynamicTool 22 / hook 17, and 0.48.0–0.49.1 at tool 24 / dynamicTool 21 / hook 16.
  (`hook` has sat at 22 since 0.53.0 — it is `tool`/`dynamicTool` that keep moving.)
  Verified end-to-end, not just from
  the contract tables: the rebuilt extension, `pnpm pack`ed into a real eve app, builds on eve
  0.55.0 and **fails on 0.54.5**
  (`Selected module binding "extensions/agentkit.ts" has no compile or runtime usage.` — an incompatible manifest makes the mount contribute nothing, so the error is that obtuse;
  don't expect the old explicit "requires tool contract vN" wording).
  **eve moved the tool contract inside the 0.45 patch line, twice across 0.47.7 → 0.48.0, and then
  fourteen more times across 0.49.1 → 0.55.0**, so a *patch* bump of the eve devDep can re-stamp the
  manifest and raise the floor — re-derive it, don't assume the minor is enough, and don't assume one
  release's worth of headroom. Since ~0.50 eve also **drops** contracts out of the middle of its
  supported range, so a *newer* eve is not automatically compatible either: the floor has repeatedly
  landed on the pinned version itself, with **no back-compat window at all**.
  The `eve` peer is **`">=0.76.0"`, not `"*"`** — issue #22 proved the wildcard is a trap: eve
  0.33 dropped hook contracts ≤9 *nine hours* after 0.32 shipped, so a wildcard install succeeds and
  then fails at `eve build` with a manifest error. The manifest is still the real compatibility tie;
  the peer floor is the install-time guard. **On every eve devDep bump: rebuild, read the new
  `dist/extension/_manifest.json` stamps, find the oldest eve whose capability table
  (in eve's `dist/src/compiler/extension-compatibility.js`) supports them all, and move the peer floor
  to match.**
  **Reading that table (verified on eve 0.63.0, re-verified on 0.64.1):** `EXTENSION_CAPABILITY_CONTRACTS` is still the
  internal const — `{ <capability>: { current, supported[], dropped{<version>: "why"} } }`, and the
  `dropped` strings are the best available changelog for *why* a contract went away — but it is **not
  exported**. The **exported** names are **`EXTENSION_CAPABILITY_SUPPORT`** (capability → `supported[]`),
  **`EXTENSION_CAPABILITY_VERSIONS`** (capability → `current`, i.e. exactly what a build stamps), and
  the one-call check **`findUnsupportedExtensionCapabilities(manifest)`** — pass the **whole parsed
  manifest** (it reads `manifest.requires` itself; passing just `requires` throws
  `Cannot convert undefined or null to object`). It returns `[]` for compatible, else
  `[{capability, requiredVersion, supportedVersions}]`. So the whole floor check is:
  ```js
  const m = await import("<consumer>/node_modules/eve/dist/src/compiler/extension-compatibility.js");
  const manifest = JSON.parse(fs.readFileSync(".../dist/extension/_manifest.json", "utf8"));
  m.findUnsupportedExtensionCapabilities(manifest);        // [] === compatible
  m.EXTENSION_CAPABILITY_VERSIONS;                          // what THIS eve would stamp
  ```
  Comparing `EXTENSION_CAPABILITY_VERSIONS` against the committed manifest is the fast way to tell
  whether a rebuild would re-stamp anything **before** running it. To find the floor empirically without
  installing each eve, fetch the tarballs and regex the minified table:
  `tar -xzf eve-<v>.tgz package/dist/src/compiler/extension-compatibility.js` then match
  `<capability>:\{current:(\d+),supported:\[([0-9,]*)\]`.
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
  built in a resolver; unconfigured `search` → resolver returns `null` and the tools don't exist; and the
  input schema is passed as **plain JSON Schema** (`z.toJSONSchema(…)` into a resolver-local variable), never
  the live zod object — eve ≥0.59 replays dynamic tools from a JSON snapshot and rejects a live schema
  captured from the resolver, see the 0.63.0 bump note under Eve framework facts);
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

## eve memory slots (`@upstash/agentkit-eve/memory`, `packages/eve/src/memory/`)

- **Layout** (`packages/eve/src/memory/`): `index.ts` is the barrel + the "two seams, which to pick"
  overview and the tsup entry for the `./memory` subpath; `documents.ts` is `redisDocuments()`;
  `provider.ts` is `redisMemory()`; `memory.test.ts` covers both. The two halves share no code, so
  each file carries only the design notes that belong to it. Note the sibling **`memory-tools.ts`**
  (renamed from `memory.ts` when this directory landed, so `./memory.js` and `./memory/` can't be
  confused) — that's `defineMemoryRecallTool`/`defineMemorySaveTool`, the package-**root** exports,
  which are a different feature from the memory slots.

- **Both designs shipped, on purpose.** They are different eve seams, not competing implementations:
  `redisDocuments()` = storage under eve's `fileMemory()` (whole-document recall, model-curated,
  bounded to 4,000 recalled chars / 64 KiB stored); `redisMemory()` = a whole provider (top-K BM25
  recall of *relevant* memories, automatic capture, `forget_memory` by id, unbounded store). The
  demo declares both slots.
- **`EVAL` works on Upstash Redis over REST — verified live, not assumed** (2026-09, an
  `upstash start-redis` DB). `redis.eval(script, keys, args)` from `@upstash/redis` is accepted with
  auto-pipelining on (the default), a Lua table return round-trips as a JSON array, and
  `HGET`/`HSET`/`EXPIRE` inside the script behave normally (`SCRIPT LOAD`/`EVALSHA` work too, but the
  backend just sends the ~300-byte script each time — writes are rare and `EVALSHA` would need a
  `NOSCRIPT` fallback). This is the *only* way to satisfy `MemoryDocumentBackend.write`'s
  optimistic-concurrency contract. **`MULTI` does exist over REST** — `redis.multi()` posts to a
  dedicated `/multi-exec` endpoint and executes atomically (measured live; don't repeat the old
  claim that REST has no MULTI). It just cannot do a CAS: a transaction hands back every result at
  `EXEC`, so nothing inside it can branch on a value it just read —
  `multi().get(k).set(k,v).exec()` returns `["a","OK"]` with the `set` already done. Conditioning
  the write is `WATCH`'s job, and **`WATCH`/`UNWATCH` are what REST actually lacks**: the server
  answers `ERR Command "WATCH" is not allowed in REST`, since watching spans requests and REST keeps
  no session. A stale
  `expectedVersion` must throw eve's `MemoryDocumentConflictError` — `fileMemory()` catches exactly
  that, re-reads and retries up to 8 times, using the structural `MemoryDocumentConflictError.is()`,
  so the class is imported from `eve/memory/file` at **runtime** (the only new runtime eve import
  besides `defineTool`).
- **`@upstash/redis` auto-deserializes replies**, so a stored document whose text is valid JSON
  (`123`, `{"a":1}`) comes back as a number/object — measured. Documents are therefore stored with an
  `eve-memory-document-v1:` marker prefix (stripped on read) that makes every value unparseable as
  JSON, guaranteeing a byte-exact round trip. Layout: one hash per scope key at
  `agentkit:memoryFile:<scopeKey>` with `content` + `version` fields.
- **Upstash Search indexing lag is minutes, not seconds, without `waitIndexing()`.** Measured
  end-to-end: a fact captured at `turn.completed` was still invisible to recall 8 turns / 10s later
  and only appeared minutes afterwards. So `redisMemory()`'s capture ends with
  `searchIndex.waitIndexing()` (`waitForIndexing`, default `true`) — free, because eve runs capture
  *after* the response is delivered — and that is what makes the e2e eval pass on the very next turn.
  Recall stays wait-free.
- **`read()` is a plain `HMGET` again — the read-your-writes workaround is gone.** It used to keep a
  bounded FIFO set of scope keys it had written and re-read (up to twice) before returning `null`,
  because `@upstash/redis@1.38.0` sent its sync token one request late and an `HMGET` straight after
  the `EVAL` write could hit a replica that hadn't caught up. **Fixed upstream in 1.38.4**, which is
  now the `@upstash/redis` peer floor of `packages/eve` (`>=1.38.4`, raised from `>=1.38.0`
  precisely because this code now relies on the fix — do not lower it). Verified before removing the
  workaround, by stubbing `fetch` and reading the token off each outgoing request: 1.38.0 sends
  `[null, "", "tok-1"]` for three calls (each one behind), 1.38.4 sends `["", "tok-1", "tok-2"]`.
- **Recall must be replay-stable, and the cache stays — this was checked with Vercel, don't delete it.**
  eve records a digest per `operationId` and throws *"Memory recall operation … replayed with a
  different result"* if a durable replay returns something else. eve's docs say a provider does
  **not** need to persist recall results by `operationId` *"unless its store can change before a
  replay"* (`docs/memory/custom-provider.md`, clarified in **vercel/eve#2951** after we asked —
  supermemory and `fileMemory()` don't cache because *their* stores can't). **We are the exception:**
  recall is a live ranked query plus two live counts, and `save_memory` writes `source: "agent"`
  records — exactly what recall ranks — mid-turn, while `forget_memory` flips `deleted`, capture
  appends the turn's messages, and a concurrent session on the same scope key can do any of it. So
  the rendered block is cached at `agentkit:memoryRecall:<userId>:<operationId>`
  (`replayCacheTtlSeconds`, default 3600, `0` disables), keyed per *operation* so each new turn
  still runs a fresh query.
- **What can be in the recalled block, and how each line is labelled.** A line is `<id>: <text>`
  plus a parenthesised note. Three sources land in one ranked list and each is named:
  `metadata.source` `"agent"` → *you saved this* (`save_memory`), `"userMessage"` → *the user said
  this*, `"agentMessage"` → *you said this* (`rememberMessages` `"fromModel"`/`"all"`). They are not
  equally trustworthy — a deliberate save vs. a passing remark — which is the whole reason the label
  exists. **`metadata` is unindexed** (it rides along like `createdAt` on core `AgentMemory`, whose
  generic is now the *schema*: `AgentMemory<TSchema, TMetadata extends MetadataOf<TSchema>>`, so
  `metadata` and every `filter` are derived from `metadataSchema` and checked against it): free to add, but *not filterable* — a query still matches `text`
  only, so "recall only saved facts" would need an indexed schema field and a re-index. Both write
  paths still share the `stableHash(text)` id, so identical text collapses onto one record whichever
  way it arrived, keeping the last write's metadata; and records written before `metadata` existed,
  or by the standalone memory tools that share this store, carry no source and get **no note**
  rather than a guessed one.
- **Lifecycle: eve offers four hooks, we register three** (documented in `packages/eve/README.md`
  and the `memory/index.ts` barrel): recall at `turn.started` (before the model runs) and again at
  `compaction.completed` (against the *new* checkpoint, so memory isn't folded into the summary —
  eve excludes recalled records from the summarizer); capture at `turn.completed` only (after the
  response is delivered, which is what makes the `waitIndexing()` free). **There is no
  `compaction.requested` capture** — messages are stored as they happen so the summarizer takes
  nothing with it, and it was the one context where `turn` (and so the ordering `sequence`) can be
  null. Don't re-add it from an older description of this file. `redisDocuments()` under
  `fileMemory()` only ever sees the two recall points — eve reads the document and injects it whole.
- **Recall is returned as ONE keyed message** (`id: "agentkit-redis-memory"`), like eve's own
  `file-memory-document`: eve supersedes a record when the same id comes back with different
  content, and omitting an item does **not** delete it — so per-memory ids would accumulate and a
  forgotten memory would linger in context.
- **eve requires provider tools be `defineTool()`-branded** (`isBrandedToolEntry` in
  `context/memory-tools.js` throws otherwise), and it re-invokes `provider.tools()` from a durable
  closure on every execute — so the factory must be pure. Tool names are `<slot>__<key>`.
- **`memory.scope.key` is the partition key** (eve locks it before calling the provider). It is
  sanitized `:` → `_` for `AgentMemory`'s `userId`, which rejects the key separator. `forget_memory`
  validates the model-supplied id against `/^[A-Za-z0-9_-]{1,64}$/` — it becomes a Redis key part.
- **Default prefix stays `agentkit:memory`** so slots share the memory tools' Redis Search index
  (the DB caps at 10 indexes; a slot must not mint its own). `agentkit:memoryFile` is deliberately
  *outside* `agentkit:memory:` — that prefix is the AgentMemory index's, and a document written under
  it would be indexed as a malformed memory doc.
- **`rememberMessages` defaults to `true`, and the hazard below is real — keep it documented.** Captured
  utterances and curated facts share one BM25 ranking, and the utterances win: recall builds its
  query from the user's current message, so a stored *"What do you remember?"* scores near-perfectly
  against the next *"What do you remember?"*. Measured on a live index — captured question **50.9**,
  while `User likes cucumber.` (saved deliberately via `save_memory`) was cut from the top 5
  entirely. Asking the agent what it remembers is what degrades what it remembers; `rememberMessages:
  false` is the model-curated escape hatch. (This default was flipped off and then back on: off was
  the measured-safest, on is the product call. Don't silently re-flip it either way.) `rememberMessages`
  is a union: `true` (default, and it means **`"fromUser"`** — the caller's text only) | `"all"` |
  `"fromModel"` | `false`. **No function form** — an extractor can't be passed, so `capture: false` + a live `extract` is not expressible
  and `defaultExtractMemories` is internal. `"fromModel"`/`"all"` are worse
  than `"fromUser"` (the assistant's text is derived from the recalled block, so the agent
  re-memorizes its own restatements). `"fromUser"` reads `turn.input` — the turn's own
  delivery, kept separate from projected history, so recalled records can't be re-captured; and
  every memory's id is `stableHash(text).slice(0,12)`, so identical text collapses onto one key and
  capture is idempotent across turns and replays.
- **One store, in its own keyspace — this is the load-bearing decision.** Facts and captured turns
  both live at `agentkit:memorySlot:<userId>:<id>`, with `sessionId`/`source`/`deleted` as **indexed**
  fields (plus unindexed `sequence`/`subIndex` for ordering). There is no `ChatHistory` in this path
  any more and no option; `read_session` is always contributed and reads the same
  records back, sorted `(sequence, sourceRank, subIndex)` where `source` doubles as the intra-turn
  ordinal (`userMessage` → `agent` → `agentMessage`).
- **Why its own prefix, and never `agentkit:memory`.** A schema describes an index and an index
  covers a keyspace. Upstash Search does **not** match a missing field against `{$eq: …}` and has no
  `$ne` — verified live: a doc written without `deleted` is returned by `{userId}` alone and by
  nothing that also filters `deleted:{$eq:false}`. So pointing the slot's stricter schema at the
  shared keyspace would make every record written by published `@upstash/agentkit-sdk@0.6.0`
  silently unreachable. Its own prefix means nothing older is in scope. Costs one of the DB's 10
  indexes; do not "optimise" it back into the shared store.
- **Recall injects `source: "agent"` only.** Captured turns share the store but not the ranking —
  that is the structural fix for the measured poisoning (captured question **50.9** vs a
  deliberately saved `User likes cucumber.` cut from the top 5). The block ends with a live `count`
  of non-fact records pointing at `search_memory`, because black-box testing showed the model does
  not use a tool it is merely offered: across 32 conversations it called `read_session` **zero**
  times.
- **`forget_memory` redacts, it does not delete.** Text → `""`, `deleted` → `true`; every read but
  `read_session` filters tombstones out, and `read_session` renders `[redacted]` so a reader cannot
  mistake removal for "never said". Core `AgentMemory.forget` is still a real `DEL` for its other
  callers — the provider redacts by calling `add()` with the same id, since `add` writes the whole
  document.
- **`"all"`/`"fromModel"` drop `forget_memory`, and this is load-bearing.** Those modes store the
  assistant's replies, and the assistant's reply *confirming a deletion quotes the deleted text* — so
  erasure writes a fresh copy of what it erased. Measured over 18 black-box conversations on the
  rebuilt provider: the curated fact was correctly redacted, and the phrase survived in **three**
  other records, all `agentMessage`, all replies about the deletion (a fourth was the tester's own
  search query). Agent replies were 18 of 41 records — half the store and the whole leak. A tool that
  reports "permanently deleted" while that happens is worse than no tool, so those modes contribute
  `save_memory`/`search_memory`/`read_session` only. Don't "restore the missing tool for
  consistency" — it was removed because it cannot tell the truth there.
- **Config names carry the phase** (the object is flat, so they have to): `maxRecallCharacters`
  (recalled block) vs `maxMemoryCharacters` (one stored memory), `rememberMessages`. Renamed pre-release
  from `maxCharacters`/`maxEntryCharacters`/`capture`+`extract`; `query`/`buildRecallQuery` was
  removed outright (the recall query is always the turn's user text). Every optional field carries a
  JSDoc **`@default`** tag — keep that up when adding one.
  **There is no `memoryTools` knob** — `save_memory`/`search_memory`/`forget_memory` are always
  contributed (plus `read_session` when transcripts are on), since a slot with no way to save,
  search or forget is a strange thing to declare. **`search_memory`** is the manual counterpart to
  automatic recall: recall only surfaces what matches the *current* message, so the model needs a
  way to look up an older fact after a topic change. **`./memory` had never shipped**
  (published `@upstash/agentkit-eve@0.8.0` exports only `.` and `./sandbox`), so this cost nothing —
  check that before assuming a rename here is breaking.
- **eve floor for this subpath is `>=0.45.2`, verified against the built `dist`** the same way the
  sandbox floor is: `pnpm pack` the package into a throwaway consumer that calls `defineMemory` with
  both providers, then `tsc` per eve version. **0.45.0** fails (`Cannot find module 'eve/memory'` *and*
  `'eve/memory/file'`), **0.45.1** fails on `eve/memory/file` alone, and **0.45.2 / 0.46.1 / 0.47.6 /
  0.49.0 / 0.52.2** are all clean; the runtime import throws `ERR_PACKAGE_PATH_NOT_EXPORTED` below the
  floor. `MemoryProvider`'s declared shape is byte-identical across 0.45.2→0.52.2, so
  nothing here is version-fragile.
- **What the tests pin down** (a PR review flagged that only the `profile` tools were covered):
  `memory/memory.test.ts` has an offline suite that spies `AgentMemory.prototype.recall`/`add` and
  scripts the search index, so it asserts recall/capture actually *fire* at the lifecycle
  hooks it registers and with what — the exact `{userId, topK, query, minScore}`, the
  `agentkit_memorySlot` index name, the `{userId:{$eq}, text:{$smart}}` filter, and that a replayed
  `operationId` re-queries **zero** times. The live suite then asserts the JSON documents in Redis
  (key = `recordIdFor(sessionId|sequence|source|subIndex|text)`, value = `{text,userId,createdAt}`
  plus the indexed metadata) and round-trips them back through recall.
  All of it is mutation-checked: removing a hook or the `memory.add` call turns 10 tests red.
- **E2E proof:** `examples/eve-demo` declares both slots (`agent/memory/profile.ts`,
  `agent/memory/recall.ts`) and `evals/memory.eval.ts` drives them with eve's `mockModel`
  (`AGENTKIT_MOCK_MODEL=1`, no OpenAI key). The mock echoes the memory blocks eve injected into its
  *prompt*, which is what proves automatic recall. CI runs it next to the extension eval.

## Naming history (so you don't resurrect old names)
- ai-sdk caching: `cacheTools` → `cachedTool`+`cachedTools` → now **`cachedTools` only** (singular `cachedTool` removed; toolName = map key, `userId` scopes).
- eve `cachedExecute` → **`defineCachedTool`** (cache key field: `cachePrefix` → `namespace` → **`toolName`**); `recall/saveMemoryTool` → **`defineMemoryRecallTool`/`defineMemorySaveTool`**.
- Memory + memory-tool scoping: `scope` → `namespace` → **`userId`** (string or per-call function).
- **ChatHistory is back** (was removed pending a frontend+backend solution) — now `ChatHistory` on Redis
  Search; Redis is the durable source of truth (eve's Workflow store is pruned 1–30 days after a run
  completes, per Vercel plan, so don't rely on it for long-term history).
- **Removed entirely:** the model cache (`ModelCache`/`SemanticCache`, `cachedModel`, `modelCacheMiddleware`),
  Telemetry, the generic Sandbox (sandbox is eve-only), and dead core exports `ChatMessage`/`Logger`/`noopLogger`.

## Lua scripts: always `allow-key-locking`

- **Every `EVAL` script starts with `#!lua flags=allow-key-locking` on its very first line** (same as
  `@upstash/ratelimit` since #154). Upstash then locks only the keys the script declares instead of the
  whole database. The price: **every key a script touches must be in `KEYS`** — a key built or read
  inside Lua fails with `ERR Dynamic keys are not allowed in Lua scripts when 'allow-key-locking' flag is
  set` (verified live 2026-09-27). Don't pass placeholder keys for optional indexes either; make `KEYS`
  variable-length and test `if KEYS[n]` in the script.
- Scripts that need a key they can only learn by reading (the artifact store's old run/thread index)
  read it first, declare it, and compare-and-swap inside the script, retrying on a mismatch.
- Current scripts: `RedisLock` acquire/release/extend (tanstack-ai), eve `redisDocuments()` CAS, the
  tanstack-ai persistence/generation stores, and mcp-toolkit's task update/settle and subscription put. Upstash tolerates a leading newline before the shebang,
  standard Redis does not — keep it on line 1.

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
  `agentkit:memory:<userId>:<id>` (+ optional unindexed `sessionId` → a `ChatHistory`
  `sessionId`), `agentkit:chat:<userId>:<sessionId>`,
  `agentkit:memoryFile:<scopeKey>` (eve memory-document backend — a **hash**, not JSON),
  `agentkit:memoryRecall:<userId>:<operationId>` (eve recall replay cache),
  `agentkit:sandbox:template:<name>:<templateKey>` (default prefixes shown).
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
- **AI SDK v7 stable everywhere.** Every package + demo pins `ai` to exactly **`7.0.130`**. `eve` (0.63.0 through 0.69.0 alike)
  declares `ai` as a **peer** (`^7.0.105` — it sat at `^7.0.82` from 0.47.6 through 0.52.3, moved to
  `^7.0.93` somewhere in 0.53.0 → 0.55.0 and to `^7.0.105` by 0.61.0, so the 0.52.3 → 0.55.0 bump forced
  the repo-wide pin `7.0.87` → `7.0.101` and the 0.55.0 → 0.63.0 bump `7.0.101` → `7.0.107`), so the
  apps/packages provide the single copy. Providers:
  `@ai-sdk/openai` `^4.0.71`, `@ai-sdk/provider` `^4.0.17`, `@ai-sdk/react` `^4.0.110` (all stable ranges;
  bump them with `pnpm -r update "@ai-sdk/*"` when eve moves — a stale `@ai-sdk/react` range can pin a
  second, older `ai` copy via its peer resolution, which is exactly the two-copy breakage to avoid).
  (History: the repo was on `7.0.0-beta.178` for `eve@0.13.1`, `7.0.30` for `eve@0.25.2`, then `7.0.58`
  for `eve@0.32.0`–`0.47.3` — the exact pin moves in lockstep with eve's `ai` peer range.)
- **A stale `ai` pin is a hard install failure, not a warning.** eve 0.47.6 raised its `ai` peer
  `^7.0.58` → `^7.0.82`. pnpm only prints `unmet peer ai` in this workspace, but a real **npm**
  consumer on the old exact pin gets `npm error code ERESOLVE … peer ai@"^7.0.82" from eve@0.47.6`
  and cannot install without `--force`/`--legacy-peer-deps`. Treat eve's `ai` peer as a release-blocking
  input on every eve bump; check it with `npm view eve@<v> peerDependencies.ai`.
  **This fired again on 0.52.3 → 0.55.0** (peer `^7.0.82` → `^7.0.93`): `npm install eve@latest`
  beside the old `ai@7.0.87` pin dies with
  `npm error ERESOLVE … peer ai@"^7.0.93" from eve@0.55.0`. pnpm in-workspace was silent about it.
- The `@ai-sdk/*` bump riding along with `ai` 7.0.87 **collapsed a long-standing second `ai` copy**:
  `@ai-sdk/react@4.0.62` was resolving its own `ai@7.0.59` beside the pinned one (visible on `main` as
  two `ai@…` keys in `pnpm-lock.yaml`). After `pnpm -r update "@ai-sdk/*"` the lockfile has exactly one
  `ai@7.0.87`. Verify with `grep -oE "^  ai@[0-9][^:(]*" pnpm-lock.yaml | sort -u` after any bump.
  **It recurs every time the `ai` pin moves and you forget the provider update.** On the
  0.52.3 → 0.55.0 bump, pinning `ai@7.0.101` alone left the lockfile with *two* copies —
  `@ai-sdk/react@4.0.90` still dragged in its own `ai@7.0.87`. `pnpm -r update "@ai-sdk/*"`
  (which moved the ranges to `^4.0.66` / `^4.0.14` / `^4.0.104`) collapsed it back to one.
  Run it as step two of every `ai` pin bump, then re-run the `grep`.
- **Why exact-pin and not a pnpm `override`:** because everyone lands on the same exact `ai`, pnpm
  installs a single copy. Two copies of `ai` cause type/identity breakage. An override was tried and
  removed as unnecessary — keep it that way unless a dep forces a different `ai@7`.
- **No `pnpm.overrides` in root `package.json`.** Version alignment is the mechanism. (`@types/react` was
  also deduped by aligning `ai-sdk-demo` to `19.2.15`, not by an override.)
- `pnpm-workspace.yaml` sets `minimumReleaseAge: 0` so fresh eve/ai releases aren't gated.
- Two `zod` 4.x copies exist in the lockfile (`@vercel/cli-config`, eve-transitive, wants its own) —
  preexisting and harmless; our packages all resolve one shared zod **in this workspace**.
- **⚠️ "one shared zod" is a property of OUR LOCKFILE, not of a consumer install — never infer consumer
  dedup from a green repo.** `packages/eve-extension` used to pin `"zod": "4.4.3"` **exactly** while
  `packages/sdk` declares `"^3.23.8 || ^4"`. In the workspace both resolved to 4.4.3, so everything was
  green; in **every real consumer install (npm *and* pnpm)** the sdk resolved zod `4.6.5` and the
  extension got its own nested `4.4.3` — **two instances**. zod changed its internal schema
  representation in **4.6.0**, so a schema built by zod ≥4.6.0 cannot be converted by zod <4.6.0
  (measured: 4.4.3 ✗, 4.5.0 ✗, 4.6.0 ✓, 4.6.5 ✓). The extension's search resolvers call
  `z.toJSONSchema(defs.<tool>.inputSchema)` on defs built by the **sdk's** zod, so cross-instance it
  threw `Cannot read properties of undefined (reading 'push')`; eve logged
  `[eve:dynamic-tools] … failed — skipping its complete result` and all three search tools **silently
  never mounted**, with `eve build` green. Fixed by widening the extension to **`"^4.4.3"`** so normal
  resolution dedupes to one instance. **Rules that follow:** (1) never exact-pin `zod` in a *published*
  package — a range that overlaps the sdk's is what makes dedup possible (exact-pinning is the right
  move for `ai`, the opposite of the right move for `zod`, because `ai` is pinned identically in *every*
  workspace package while `zod`'s ranges differ); (2) a dual-instance bug of this class is **invisible to
  every in-repo check** — only a packed-tarball consumer install can see it, so verify dependency changes
  to `packages/eve-extension` with `pnpm pack` into a scratch consumer (see "Verifying a consumer install").
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
- **`upstash start-redis` needs no account or API key** (confirmed 2026-09): `npm i -g @upstash/cli`
  then `upstash start-redis` prints a free REST URL + token, valid 72h. That is how to get creds in a
  box that has none — write them to the repo-root `.env` (gitignored) and the suites stop skipping.
- **Throwaway DBs from `upstash start-redis` (the `@upstash/cli` command; `npm i -g @upstash/cli`)
  cap at *one* search index**, not 10 — `ERR Exceeded max index count of 1`. A single `pnpm test`
  cascades into bogus create-index failures on one. Run **one test file at a time** with a `FLUSHDB`
  between (`curl "$URL" -H "Authorization: Bearer $TOKEN" -d '["FLUSHDB"]'`; FLUSHDB does drop
  indexes, and `SEARCH.DROP <name>` is the only other lever — there is no list command).
- **Throwaway DBs also *die* mid-run, and the failure mode looks exactly like a code regression.**
  Measured 2026-09-15: every `start-redis` database (they all live behind the shared
  `p2-global-eph.upstash.io` endpoint) went unreachable after roughly 3–6 test files — the REST
  endpoint stops completing the TLS handshake, so `curl` hangs to its timeout and vitest reports
  `Test timed out in 30000ms` / `Hook timed out in 10000ms` across **every** live suite at once,
  including ones that never touch search (`tool-cache`, `chat-history`). Metrics for the dead DB show
  `commands_total` stuck at a tiny number. Re-fetching the same credentials with the
  `Idempotency-Key` header does **not** revive it; only a brand-new `upstash start-redis` does.
  So: **`PING` before each test file, and reprovision + rerun the file when the ping fails** — a
  self-healing loop turns a cascade of red into a clean green run. A whole-suite red where the
  failures are timeouts rather than assertions is an infrastructure death, not a regression;
  confirm with `curl … '["PING"]'` before believing it. (`curl -X POST https://upstash.com/start-redis`
  returns the same kind of database as the CLI.)
  **But `start-redis` is rate-limited:** measured 2026-10-01, ~20 provisions inside a few minutes (one per
  test file) got `HTTP 429` with an empty body and **no `Retry-After`**, and it stayed 429 for 10+ minutes.
  A 429 makes the Endpoint/Token greps come back empty, so a script that doesn't check the status code
  silently runs the suite with **no** Redis. Reuse one database and reprovision only when its PING fails;
  check for `200` before parsing.
  On a box where `npm i -g` is not writable, install the CLI to a prefix:
  `npm i -g @upstash/cli --prefix /tmp/upstash-cli` → `/tmp/upstash-cli/bin/upstash`.
- **A brand-new throwaway DB is often DEAD ON ARRIVAL — always `PING` it before writing it to `.env`.**
  The note above says "only a brand-new `start-redis` does [revive things]"; that is too optimistic.
  Measured 2026-09-22: a just-provisioned database answered `curl` with **exit 35 / `SSL_ERROR_SYSCALL`**
  on the very first request and never recovered, and three consecutive fresh databases each failed the
  6th of 6 warm-up pings. They all share the `p2-global-eph.upstash.io` endpoint, so "fresh" buys
  nothing on its own. **Provision in a loop and only accept a candidate that answers several
  consecutive `PING`s**, e.g.:
  ```bash
  for i in $(seq 1 6); do
    out=$(curl -s -X POST https://upstash.com/start-redis)
    U=$(echo "$out" | grep -oP '(?<=\*\*Endpoint:\*\* )\S+'); T=$(echo "$out" | grep -oP '(?<=\*\*Token:\*\* )\S+')
    ok=0; for n in $(seq 1 6); do
      [ "$(curl -s --max-time 12 "$U" -H "Authorization: Bearer $T" -d '["PING"]')" = '{"result":"PONG"}' ] && ok=$((ok+1)); sleep 2
    done
    [ $ok -ge 6 ] && { printf 'UPSTASH_REDIS_REST_URL=%s\nUPSTASH_REDIS_REST_TOKEN=%s\n' "$U" "$T" > .env; break; }
  done
  ```
  A healthy DB runs a whole eval in **~350ms**; when you see a mocked eval take **3–4 minutes**, that is
  `@upstash/redis` burning its retry/backoff budget against a dead endpoint, *not* slow code. The
  distinguishing detail in a failing eval gate: `observed <tool> calls: {}` means the tool **mounted and
  ran** (and Redis failed underneath), whereas `observed tools: [<other>]` means the tool **never
  mounted** — only the latter is a real code problem.
  **Idle control settles it:** provision one more DB, run nothing against it, PING it every 15s. On
  2026-09-30 an untouched DB passed 6/6 warm-up PINGs and was dead 25s later; when that happens, no
  live result from that box means anything.
- **The read-your-writes sync-token bug is FIXED as of `@upstash/redis@1.38.4`** (the repo is pinned
  `^1.38.4`; `packages/eve`'s peer floor is `>=1.38.4`). Historically, in **1.38.0 and earlier back to
  1.34.5**, `HttpClient.request()` built `requestHeaders` from `this.headers` and only *then* copied
  `this.upstashSyncToken` into it, so every request was sent with the token from one response ago; a
  read issued right after a write could reach a replica that hadn't caught up. It was a race — the
  replica is normally current within a round trip — so it only ever surfaced as a rare CI red, and it
  cost PR #33 one (`memory/memory.test.ts`, "creates with expectedVersion null, then round-trips
  through read" — `expected null to deeply equal {…}`). This was **never** the search-index lag
  documented above; it hit plain `GET`/`HMGET`/`TTL` on ordinary keys. **Do not reintroduce
  workarounds for it, and do not lower the floor below 1.38.4.** To re-verify after a dependency
  change, stub `fetch` and read `upstash-sync-token` off each outgoing request: three calls should
  send `["", "tok-1", "tok-2"]`, not `[null, "", "tok-1"]`. Note the search-index `pollUntil`s in the
  suites are for a *different* problem and stay.
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

## MCP toolkit facts (`packages/mcp-toolkit`) — IMPORTANT
- **Layout:** three entry points, built to `dist/tasks/index.js`, `dist/events/index.js` and
  `dist/upstash.js`. `src/tasks/index.ts` and `src/events/index.ts` must never import an
  `@upstash/*` package (check the built `dist/{tasks,events}/index.js` imports); the backends live
  in `src/{tasks,events}/backends/` and are exported only from `src/upstash.ts`.
  There is no root export. Shared: `src/shared/{auth,clients,crypto,env}.ts` (principal resolution,
  lazy Upstash clients + `nonRetryable` + `readQStashJson` + `boundToUrl`, WebCrypto helpers, and
  the dependency-free `env`/`INTERNAL_ERROR`), `src/telemetry.ts`, `src/version.ts`. The cores may
  import `shared/env.ts` but **never `shared/clients.ts`** — it imports `@upstash/redis` and
  `@upstash/qstash`, and the bundler would pull them into `/tasks` and `/events` (this happened
  once, caught only by grepping the built chunks: `grep -l "@upstash/" dist/chunk-*.js`).
  **WebCrypto only** (no `node:crypto` / `node:net`), so it runs on edge runtimes; `signWebhook`,
  `SecretBox.seal/open` and `subscriptionId` are async for that reason.
- **Tools mode, not the Tasks extension (since 2026-10).** A task tool answers with an ordinary tool
  result (`structuredContent` = the task object, plus a text line telling the model to poll); two
  shared tools, `task_status` and `task_cancel`, are registered once per server. No `tasks/*`
  methods, no capability check, no custom transport — the demo serves through `createMcpHandler`.
  Reason: no mainstream client (Claude Code, Codex, Cursor, OpenCode) declares
  `io.modelcontextprotocol/tasks` as of 2026-10-07, and a server must not return a task to a client
  that did not. A native adapter can sit on the same store/dispatcher later — don't reintroduce the
  old `methods`/`onMissingCapability`/`-32021` machinery into the core.
- **`define` / `register`, never one call (DX-3022 review item 1).** `tasks.define(name, config,
  handler)` runs at module scope and fills the handler map; `tasks.register(server)` attaches every
  defined tool + the shared tools inside the per-request factory. The old
  `registerTask(server, …)` only filled the map when a server was built, so a cold instance serving
  only `/api/execute` threw "No task handler" and every delivery 500'd — don't bring it back, and
  don't reintroduce the top-level `createServer();` workaround.
- **Ownership (`principal` is required, both layers).** `createTaskLayer` / `createEventLayer`
  throw without it. It receives `{ auth, request }` (SDK v2's `ctx.http.authInfo` and
  `ctx.http.req`), may be async, and stamps `task.owner` / `subscription.owner`. `auth` is only what
  the app's route passed to `handler.fetch(request, { authInfo })` after verifying the token: the
  SDK never derives it from headers. `request` is unverified, for cookie/session apps; docs warn
  against trusting caller-set headers. `PrincipalResolver` returns a plain **string**
  (`string | Promise<string>`; the old `{ id, context }` form is gone): it **throws** to refuse,
  and `resolvePrincipal` also fails closed on a rejection or anything but a non-empty string.
  Refused = not authenticated: the call is
  refused (`isError` "Not authenticated" for tools, reason `not_authenticated` for events/*) — no
  anonymous mode, fail closed; a stored task without an owner answers nobody. Single-tenant servers
  pass `principal: () => "local"`. `task_status` / `task_cancel` take `z.uuid()` task ids (so
  nothing else reaches a Redis key) and report a non-owned task as *unknown* (no existence oracle).
  Owners are JSON-encoded on write, so auto-deserialization hands them back as strings and a plain
  `===` compares them. The public `TaskLayer` is only `{ define, register, createExecuteHandler }`;
  a dispatcher gets `run` / `fail` as the argument of its `createExecuteHandler(endpoints)` (there
  is no `attach`). Tests drive deliveries with `ManualDispatcher` / `InlineDispatcher` from
  `src/test-support.ts` — call `tasks.createExecuteHandler()` once to connect them — and the
  in-memory backends (`MemoryTaskStore`, `MemorySubscriptionStore`, `InlineDelivery`) live there
  too: they are **not shipped**.
- **No `idempotencyKey` (removed 2026-10-08, keep it simple; add back only if someone asks).** Task
  ids are always `crypto.randomUUID()`, so `TaskStore.create` is a plain `MULTI` (`HSET` +
  `PEXPIRE`) returning `void` — no create-if-absent script, since a collision cannot happen.
  `ttlMs` is always a positive number (`null` = unlimited was removed: it let tasks live forever).
- **Workflow route steps first (fixed 2026-10-08, caught by the e2e failure check).** Workflow
  authorizes every request, the failure callback included, by running the route function on a
  `DisabledWorkflowContext` until its first step; a route that throws or returns before any step
  is refused (`Not authorized to run the failure function`). A handler that threw before its first
  `task.run` therefore never reached `failureFunction` and stayed `working` until its TTL.
  `workflowRoute` now runs a `mcp-task:start` step before anything else.
- **Default task TTL is 1 day (changed 2026-10-08 from 5 minutes).** The TTL counts from creation
  and is never extended, so 5 minutes let a slow task plus its QStash retries expire mid-run and
  read as "unknown task". The demo servers use the default.
- **Signing keys required, no fail-open.** `QStashDispatcher`, `WorkflowDispatcher` and
  `QStashDelivery` verify with `receiver` or a `Receiver` from the `QSTASH_*_SIGNING_KEY` env vars,
  and throw on the first request when neither exists (resolved outside the verify `try`, so it is
  not misreported as a 401). `WorkflowDispatcher` passes `receiver` to `serve()` explicitly because
  Workflow's own default silently skips verification when the env vars are missing; the `serve`
  handler is built on the first request so route modules still evaluate at build time.
  **Workflow does not bind the signature to the URL** (verified in `@upstash/workflow` 1.3.3 and
  1.4.0: `verifyRequest` calls `verifier.verify({ body, signature })` with no `url`), so a QStash
  signature issued for *any other endpoint of the same account* was accepted and the task ran —
  measured by reverting the fix. The receiver handed to `serve()` is `boundToUrl(receiver, url)`;
  `workflow.test.ts` "refuses a signature QStash issued for another endpoint" guards it.
  Signature tests use a **real** `Receiver` with test keys and real HS256 JWTs (`signQStash` /
  `qstashRequest` in `test-support.ts`): wrong key, wrong `sub`, wrong body hash, expired — never a
  stubbed `verify`.
- **Telemetry:** `addTelemetry` (Redis) and `addQStashTelemetry` (QStash `Client`, or a Workflow
  `Client` via its `.client`) append `@upstash/mcp-toolkit@<v>` to `Upstash-Telemetry-Sdk`, once
  per client; `enableTelemetry: false` on each backend opts out.
- **Round trips:** `RedisTaskStore.create` is one `MULTI`; `update` and `settle` share one
  guarded-write script (terminal statuses hardcoded as JSON literals) that returns `HGETALL` after
  the call. `update` returns `void` (no-op on a missing or terminal task; `UnknownTaskError` is
  gone), `settle` returns the task after the call (null only when missing). `task_cancel` calls
  `dispatcher.cancel(taskId)` when the returned status is `cancelled` — `cancel` must be
  idempotent. There is no `dispatchId`: `QStashDispatcher.cancel` is a no-op (a redelivery of a
  cancelled task finds it settled and does nothing), Workflow's run id is the task id.
- **No QStash `deduplicationId`** (tasks or events): the layer dispatches each task once, and an
  event's id reaches the host as `webhook-id`, which is where Standard Webhooks dedupes. Workflow's
  `workflowRunId` is the task id; that is only safe because ids are random (Workflow refuses a
  reused run id). A failed `dispatch` settles the fresh record `failed` ("Could not be queued") and rethrows.
- **Workflow context is inferred** from the dispatcher (`TaskDispatcher<TContext>`), so
  `createTaskLayer({ dispatcher: new WorkflowDispatcher(...) })` types `task.run` / `task.sleep` with
  no type argument; a test in `workflow.test.ts` keeps it that way.
- **`RedisSubscriptionStore` = one index per event** (`<prefix>idx:<event>`, a zset scored by
  expiry, no TTL — bounded by the number of event names) plus `<prefix>sub:<id>` with `PX`. `put`
  and `delete` are plain `MULTI`s (the old Lua PUT and the 256-subset `argsKey` index are gone);
  `put` prunes expired members. `find(event)` = one `ZRANGE` by score + `MGET`s of at most 1,000
  keys, and the **layer** filters in JS (`matches(sub.args, values)`). O(subscribers of the event)
  per emit — fine at MCP-host scale; revisit only if an event gets tens of thousands.
- **No secret defaults:** `MCP_EVENTS_SECRET_KEY` has no fallback, demo included; the event layer
  resolves it on first use (not at construction, so builds without env still work) and a missing key
  throws rather than dropping deliveries.
- Running a missing/expired task is a no-op (QStash acks 200) instead of throwing — a retry cannot
  fix it. Handler throws are logged with the task id before the 500.
- **Design choices that differ from the naive version** (all covered by tests):
  `TaskStore.settle` is a *guarded, atomic* terminal transition (a Lua script on Redis) so a
  `task_cancel` and the executor completing cannot clobber each other — first terminal write wins;
  the store keeps **one hash field per task property** (not one JSON blob) so a progress `update` and
  a cancel never overwrite each other's fields; and the core never settles `failed` itself — only the
  dispatcher does, once it has stopped retrying.
- **Redis encoding:** every hash field is written `JSON.stringify`d and read back with **no decode of
  our own** — `@upstash/redis` auto-`JSON.parse`s responses, so the single parse is the exact inverse.
  Decoding again turns a `statusMessage` of `"123"` into the number `123` (this actually happened).
- **QStash retry budget must outlast a restart.** `Upstash-Retried` (count so far, from 0) is the only
  retry header; there is no max-retries header, which is why the final failure comes from QStash's
  `failureCallback` (posted to the same route, `sourceBody` = the original body) rather than from
  counting attempts (`isFinalQStashAttempt` is gone). With a flat `"1000"` delay a kill-9'd server exhausts all retries in ~10s
  and the task is dead-lettered while still reading `working` — observed, then fixed, then re-verified
  end to end (kill -9 mid-task → restart → QStash redelivery → `completed`).
  **`retries` is plan-capped:** the local dev server and the free tier reject anything above **5**
  with `quota maxRetries exceeded` (this bit a `DEFAULT_RETRIES = 12` attempt — the tool call comes
  back as an `isError` result carrying that message, not as a thrown error). So the budget is bought
  with backoff instead: `DEFAULT_RETRIES = 5` and
  `DEFAULT_RETRY_DELAY = "min(pow(3, retried) * 1000, 300000)"` ≈ 2 minutes over five attempts.
- **The dispatcher owns its delivery endpoint** (`TaskDispatcher.createExecuteHandler(endpoints)`,
  surfaced as `tasks.createExecuteHandler()`; `EventDelivery.createDeliveryHandler(send)` likewise,
  sharing `readQStashJson` for verify + parse): signature verification, task-id parsing and
  the retry status codes live in the transport, so an app route is one line and cannot forget
  `Receiver.verify`. Modelled on Vercel Workflow's `Queue.createQueueHandler` (see below). Status
  contract: **200** ack, **500** only when the task threw, and **489 + `Upstash-NonRetryable-Error:
  true`** for a bad signature or body. QStash retries *every* other non-2xx, 401 and 400 included
  (checked against the QStash retry docs 2026-10-08), so 489 is the only way to stop it. The same
  contract holds for `QStashDelivery`. The receiver is resolved lazily but outside the verify `try`,
  on purpose: resolving at `createExecuteHandler()` would fail Next.js builds that import route
  modules without env. Verification uses the
  **published** `url`, not `request.url`, because behind a proxy the incoming URL is the internal one
  while QStash signed the public destination.
- **Ecosystem context (verified 2026-09).** Keep two axes apart when reading this — *is there an
  interface you can implement* is not *does Redis work today*, and the answers invert.
  Among *official* MCP SDKs, only **C#** ships a store interface you can implement (`IMcpTaskStore`,
  7 methods) — but the only in-box implementation is `InMemoryMcpTaskStore`, so Redis is homework.
  Rust's `TaskManager` is a concrete in-memory struct with no trait; Python/Java have store
  interfaces only in unmerged PRs; Go/Kotlin/Swift/Ruby have none.
  Unofficial **FastMCP** is the mirror image: no implementable seam (Docket is both queue and store,
  and you pick a backend by URL scheme — `memory://` or `redis://`, nothing else), but Redis works
  out of the box with one URL, and it is the only tasks implementation anywhere that makes the
  *work* durable (Docket queue plus `worker_cli` workers out of process; the memory backend is
  single-process).
  **No official SDK in any language abstracts execution** — all of them `Task.Run`/`tokio::spawn`/
  `.subscribe()` in-process, i.e. durable record, non-durable work. So this package's
  `TaskStore` + `TaskDispatcher` split is not a port of prior MCP art — the closest analogue is
  Vercel Workflow's `World = Storage + Queue + Streamer`.
- Tests: `src/{tasks,events}/core.test.ts` drive a real `McpServer` through `createMcpHandler` over
  genuine JSON-RPC; `src/*/backends/qstash.test.ts` hit real Redis. All run under the root vitest
  config. The demo's `pnpm e2e` (`scripts/e2e.mjs`) is the end-to-end check and runs in CI after the
  example build: it starts the QStash dev server (:8181) and `next start` (:3100) with
  `MCP_TOOLKIT_E2E=1`, then runs `scripts/smoke.mjs` against `/api/mcp` and `/api/mcp-workflow`. No
  model. Users are `Bearer demo-<name>` (`app/lib/auth.ts`; no header = `demo-user`). It covers
  completion, cancel, cross-user isolation, 401, the failure path (`always_fail`, defined only under
  `MCP_TOOLKIT_E2E` with retries cut), refused unsigned/forged deliveries, filtered and signed
  webhooks, `authorize` at delivery (`demo-intern` never gets production), and 410 deleting the
  subscription (checked in Redis). `pnpm smoke` alone runs the same checks against a running app.
  The demo keeps tasks (Report Desk, `/api/mcp`) and events (Deploy Watch, `/api/deploy-watch`) in separate
  servers on purpose. The events tests stub the **global** `fetch` (`vi.stubGlobal`) — the layer
  has no `fetch` option.
- **Events facts.** Wire format follows ChatGPT's MCP Events (webhook only): `events/list|subscribe|
  unsubscribe` registered via `server.server.setRequestHandler(method, { params }, handler)` and
  `registerCapabilities({ events: {} } as never)` (the SDK has no events types). Subscription id =
  `sub_` + sha256(canonical `[subscriber, url, event, args]`), so unsubscribe/refresh can only ever
  touch the caller's own record (tested). **An event's values come from ONE place, the payload**
  (the user's call, 2026-10-08: "it doesn't make sense for emit to get the docId as two
  parameters"): `emit(payload, { eventId? })` is the whole API, `define` throws unless every
  `input` field is also a `payload` field, and `valuesOf(input, payload)` gives the values used
  both to **match** (a subscription matches when every arg it gave equals the payload's value) and
  to **authorize**. **Access model:** the filter says *what*, a **required** `authorize` says *who
  may* — at subscribe/refresh with the subscription's args (`phase: "subscribe"`, with
  `auth`/`request`), and in `send()` before every delivery with **the event's values, not the
  subscription's args** (`phase: "deliver"`, principal only; the token is never stored). That is the
  fix for the review's medium finding: checking `sub.args` let a subscriber with no filter (`{}`)
  pass `authorize({})` and receive every document's events, and the old explicit `emit(payload,
  { args })` could route doc A's payload to doc B's readers. `core.test.ts` "checks a subscriber
  without a filter against each event's own values" guards it (mutation-checked). A refusal at
  delivery is final (done), a throwing `authorize` retries. `send` returns a boolean (`true` =
  done, `false` = retry). Removed on purpose — don't bring back: `personal`, `to`, `match`,
  explicit `args`, principal `context`, `taskFinishedEvent`/`onSettle`, `timestamp`,
  `EmitResult.matched`, `list()`, `timeoutMs`/`fetch`/`defaults` on the event layer.
  `subscribe` resolves the principal **before** validating anything (no info to anonymous
  callers). Secrets are AES-256-GCM sealed under `secretKey` (`MCP_EVENTS_SECRET_KEY`), which must
  decode to **≥ 32 base64 bytes** (`openssl rand -base64 32`); `SecretBox.open` returns `null` on
  a tampered/rotated secret. A refresh with the same secret skips the challenge. A failed challenge is always the same
  `ProtocolError(-32015, "Callback URL failed verification")` with no reason or status (no network
  probing); the detail is `console.warn`ed. The challenge answer is read capped at 4 KB, delivery
  bodies are cancelled, and 3xx is dropped. `callbackUrlProblem` strips trailing dots and refuses
  **every IP literal** (v4 after the URL parser's normalization, and any `[…]` v6) plus
  localhost/single-label/`.local`/`.internal`; the old private-range/NAT64/6to4 parser is gone.
  It does not resolve DNS. Bad params are `-32602` with a `reason`.
  **Subscription limit:** `maxSubscriptions` (default 8, `Infinity` = off) live subscriptions per
  subscriber across all events. The layer checks `store.count` before the challenge (no outbound
  POST for a caller at the limit), and `put(sub, { limit })` re-checks atomically (Redis: one Lua
  script over `idx:<event>` and `by:<subscriber>`). Refreshes never count. Routing and delivery-time
  `authorize` use the payload's input fields *parsed with `input`* (`projection`), so transforms
  match on both sides; a payload that doesn't fit `input` makes `emit` throw.
  QStash `deduplicationId` cannot contain `:` (dev server answers 400), one more reason not to
  derive it from caller-chosen event ids.
- **Local dev needs the QStash dev server** (`npx @upstash/qstash-cli dev`) — it prints deterministic
  creds. `APP_URL` must be reachable *from QStash*.

## Eve framework facts
- **The repo is split (since 2026-09-30): `packages/eve-extension` + `examples/eve-extension-demo` are
  on `eve@0.76.0` (extension peer `>=0.76.0`, since 2026-10-10; 0.75.1 / `>=0.75.0` was never released; 0.74.0 / `>=0.74.0` was the previous floor; 0.70.0 / `>=0.70.0` and 0.72.1 / `>=0.72.0` were never released);
  `packages/eve` + `examples/eve-demo` stay on `eve@0.65.0` (peer `>=0.65.0`)** — see the 0.68.0 → 0.69.0
  and 0.65.0 → 0.68.0 bump notes below. Before that (2026-09-23)
  it was one `eve@0.65.0` everywhere, with both packages declaring `eve: ">=0.65.0"`. (For one
  day the repo was also split earlier: the extension on 0.64.1, `packages/eve` on 0.63.0, because eve 0.64.0 removed
  the `SandboxBackend*` authoring types that `packages/eve/src/sandbox.ts` implemented.) eve 0.64
  replaced sandbox **backends** with **providers** (`eve/sandbox/provider`: `defineSandboxProvider`,
  `SandboxProvider*`, `SandboxDeleteOptions`) and object-form `defineSandbox({ backend, bootstrap,
  onSession })` with exported environments + `defineSandbox(() => environment.open())`; the sandbox
  was ported to that API (see Known issues). Nothing else in `packages/eve` needed a change for
  0.63 → 0.65: memory, tools, auth and search typecheck and test unchanged.
  **Why the peer is `>=0.65.0` and not lower:** a single peer range covers the whole public surface.
  `./sandbox` needs ≥0.64 (provider API), and the decision on 2026-09-23 was to require the latest eve
  across all packages rather than carry a split floor. The older floors recorded below (`>=0.45.2` for
  `./memory`, `>=0.32` for the root) describe what those entry points *need*, not what is declared.
  Subpath exports:
  `eve/tools`, `eve/hooks`, `eve/extension`, `eve/context`, `eve/instructions`, `eve/sandbox`,
  `eve/sandbox/provider`, `eve/sandbox/vercel`, `eve/channels/*`, `eve/next`, `eve/react`,
  **`eve/memory`**, `eve/memory/scope`, `eve/memory/file`, `eve/memory/file/vercel`, `eve/evals`,
  `eve/evals/expect`, …
  **Memory landed late:** `eve/memory` first exists in **0.45.1** and `eve/memory/file` in **0.45.2**
  (0.45.0 and everything below has neither) — measured with `npm view eve@<v> exports`. That is the
  real floor for `@upstash/agentkit-eve/memory` on its own.
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
  shipped `dist` named no post-0.32 type — true of the dist *at that time*; `0.9.0`'s `./memory`
  subpath later broke that, and the floor is now `>=0.45.2`. See the version bullet at the top of
  this section — the log entries below record what was true per bump, not the current floor).
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
- **The 0.49.0 → 0.52.2 bump needed no source change, and again moved only the extension's floor —
  but it is the first bump where eve *dropped* contracts out of the middle of its supported range.**
  The extension rebuild re-stamped **tool 24→30, dynamicTool 21→29, hook 16→20** (instructions 2,
  config 1, extension 1 unchanged), moving its peer floor `>=0.48.0` → **`>=0.52.2`**. Only 0.52.2
  accepts the new dist: 0.52.1/0.52.0 top out at tool 29, 0.51.1 at tool 27, 0.51.0 at tool 25 /
  hook 18, 0.50.0 at dynamicTool 22 / hook 17. Proven by `pnpm pack`ing the rebuilt dist into a real
  eve consumer — 0.52.1 installs cleanly and then fails `eve build` with the usual obtuse
  *"has no compile or runtime usage"*, 0.52.2 builds and mounts all 7 tools + the hook.
  **The new hazard: a newer eve is no longer automatically compatible.** 0.52.2's supported `tool`
  list is [1–13, **28, 29, 30**] — 14–27 are all in `dropped` ("TaskExec.delegated was removed;
  migrate to workflow-backed background tools"), and dynamicTool/hook dropped entries cite
  "Message and reasoning append events now expose deltas instead of cumulative snapshots". That is
  why the **published** `0.9.0` dist (tool 24, built with 0.49.0) breaks on every eve from **0.50.0**
  up while its `>=0.48.0` peer happily admits them — a floored peer with no ceiling is still a trap
  when the framework drops contracts. Despite those scary drop reasons, **no source change was
  needed**: the `chat_history` hook only subscribes to `message.received`/`message.completed`
  (not the append events), and nothing in the repo touches `TaskExec.delegated` — both packages'
  sources typecheck clean against 0.52.2. eve's `ai` peer stayed `^7.0.82`, so the repo-wide `ai`
  7.0.87 pin did not move. `packages/eve`'s peer stayed **`>=0.32.0`**, re-verified by typechecking
  its built `dist` against 0.32.0/0.44.3/0.45.2/0.47.6/0.48.0/0.49.0/0.50.0/0.51.1/0.52.2 (all clean);
  its `dist` is **byte-identical to the published 0.9.0**, so `@upstash/agentkit-eve` gets no
  changeset this round — only `@upstash/agentkit-eve-extension` ships different bytes.
  **Expect a large `pnpm-lock.yaml` diff on this bump (~550 lines, mostly deletions) — that is
  normal, not corruption.** eve's `nitro` dep moved `3.0.260610-beta` → `3.0.260903-beta`, and the
  new nitro dropped a pile of optional peer deps (`vite`, `rollup`, `jiti`, `chokidar`, `dotenv`,
  `@upstash/redis`), which collapses eve's long peer-suffixed resolution key
  `eve@0.49.0(@opentelemetry/api)(@upstash/redis)(ai)(chokidar)(dotenv)(jiti)(rollup)(vite)` down to
  `eve@0.52.2(@opentelemetry/api)(ai)` and garbage-collects the now-unreferenced entries. Confirm with
  `pnpm install --frozen-lockfile` (must print "Already up to date"), not by eyeballing the line count.
- **The 0.52.2 → 0.52.3 bump needed no source change, and again moved only the extension's floor —
  but unlike every bump before it, this one fixes *no* break.** The extension rebuild re-stamped
  **tool 30→32, dynamicTool 29→31, hook 20→22** (instructions 2, config 1, extension 1 unchanged),
  moving its peer floor `>=0.52.2` → **`>=0.52.3`**. Only 0.52.3 accepts the new dist — 0.52.2 tops
  out at tool 30 / dynamicTool 29 / hook 20 — proven by packing the rebuilt dist into a real eve
  consumer: on 0.52.2 it fails `eve build` with the usual obtuse *"has no compile or runtime usage"*,
  on 0.52.3 it builds and mounts all 7 tools + the hook.
  **The difference that matters: eve 0.52.3 did NOT drop the contracts the published `0.10.0` needs.**
  0.52.3 still supports tool 30 / dynamicTool 29 / hook 20 (its `tool` list is [1–13, 28–32], i.e. it
  *added* 31/32 without dropping 30), so published `0.10.0` installs **and builds** fine on eve 0.52.3
  — verified in a scratch consumer with `eve@latest` + `@upstash/agentkit-eve-extension@latest`, which
  mounts all 7 tools and the hook. So this rebuild is **"keep the stamps current", not a fix**: its only
  consumer-visible effect is that the raised floor makes the new version unusable on 0.52.2. Weigh that
  before shipping it — holding the rebuild is a legitimate option while 0.10.0 still works on latest,
  and `>=0.52.3` should not be raised as a reflex.
  `packages/eve`'s peer stayed **`>=0.32.0`** and it ships **no changeset**: its `dist` is
  **byte-identical** before and after the bump (`diff -r` over the whole built output, `.js` + `.d.ts`),
  so only its devDependency moved. eve's `ai` peer stayed `^7.0.82`, so the repo-wide `ai` 7.0.87 pin
  did not move. The lockfile diff is small this time (~30 lines) — no nitro churn, unlike the previous bump.
- **The 0.52.3 → 0.55.0 bump (2026-09-15) needed no source change, moved the extension's floor by
  three minors, and — for the first time since 0.47.6 — moved the repo-wide `ai` pin.**
  eve went 0.52.3 → **0.55.0** in a week (0.52.4, 0.52.5, 0.53.0, 0.53.1, 0.54.0, 0.54.2–0.54.5, 0.55.0).
  The extension rebuild re-stamped **tool 32→38, dynamicTool 31→37** (hook stayed 22; instructions 2,
  config 1, extension 1 unchanged), moving its peer floor `>=0.52.3` → **`>=0.55.0`**. Only 0.55.0
  accepts the new dist — 0.54.4/0.54.5 top out at tool 36 / dynamicTool 35 — proven by packing the
  rebuilt dist into a real eve consumer: 0.54.5 installs fine (the old `>=0.52.3` floor lets it) and
  then fails `eve build` with the usual obtuse *"has no compile or runtime usage"*; 0.55.0 builds and
  mounts all 7 tools + the hook.
  **Published `0.10.0` was NOT broken by 0.55.0** — 0.55.0's `tool` list is [1–13, 28–32, 34–38] and
  its `hook` list still has 20, so the published stamps (tool 30 / dynamicTool 29 / hook 20) remain
  supported; a scratch `npm install eve@latest @upstash/agentkit-eve-extension@latest
  @upstash/agentkit-eve@latest` consumer resolved **eve 0.55.0** and `eve build` **succeeded**,
  mounting all 7 tools + the hook, with a `defineMemoryRecallTool` tool from `@upstash/agentkit-eve`
  alongside. So this is again a "keep the stamps current" rebuild, not a fix.
  **The new thing on this bump: eve's `ai` peer moved `^7.0.82` → `^7.0.93`**, which makes the old
  exact `ai@7.0.87` pin a hard **npm** ERESOLVE failure against `eve@latest`. Repo-wide pin went to
  **`7.0.101`**, plus `pnpm -r update "@ai-sdk/*"` to collapse the second `ai` copy `@ai-sdk/react`
  drags in (see the AI SDK section).
  `packages/eve`'s peer stayed **`>=0.32.0`** and it ships **no changeset**: its `dist` is
  **byte-identical** before and after the bump (`diff -rq` over the whole built output, `.js`, `.d.ts`
  *and* `.map`), and `defineSandbox({ backend: upstash() })` against that dist typechecks clean on
  0.32.0/0.45.2/0.47.6/0.52.3/0.54.5/0.55.0. `packages/eve/src/sandbox.ts`'s `SandboxBackendHandle`
  implementation needed **no** new member for 0.55.0 — `pnpm typecheck` is clean across all four packages.
  Even the extension's compiled output is unchanged: **`_manifest.json` is the only file in
  `packages/eve-extension/dist` that differs from published `0.10.0`.**
- **The 0.74.0 → 0.76.0 bump (2026-10-10; first built against 0.75.1 on 2026-10-09) is EXTENSION-ONLY again.** The 0.76.0 rebuild re-stamps **tool 80→84, dynamicTool 75→77, hook 41→43**; a consumer on 0.75.0 or 0.75.1 fails `eve build` with the packed dist ("has no compile or runtime usage"), 0.76.0 mounts clean, so the floor is **`>=0.76.0`** (published 0.16.0 78/73/39 still builds clean on 0.76.0; `packages/eve` on 0.76.0 still fails `TS2305`/`TS7006` in `src/sandbox.ts:63,334`). The 0.75.1 notes follow. `packages/eve` + `examples/eve-demo` stay on 0.65.0: besides the long-known
  `MutableNetworkSandboxSession` removal (`TS2305`), eve 0.75.0 renamed the sandbox provider handle hooks `onSessionStop`/`onSessionDelete` →
  `onSandboxStop`/`onSandboxDelete` (and added `onSessionEnd`); on 0.75.1 `src/sandbox.ts` fails with `TS2353` at `createHandle`, plus implicit-any
  cascades. Needs a source change. The extension rebuild re-stamps **tool 78→80, dynamicTool 73→75, hook 39→41**; a consumer on 0.74.0 fails
  `eve build` with the packed dist, 0.75.0 and 0.75.1 mount clean, so the floor moved `>=0.74.0` → **`>=0.75.0`**. Published 0.16.0 (78/73/39) still
  builds clean on 0.75.1. Also bumped: `ai` 7.0.136, `@tanstack/ai` 0.66.0, `-memory` 0.2.11, `-client` 0.39.0, `-openai` 0.28.0, `-react` 0.30.1,
  `@upstash/box` ^0.7.9; `@tanstack/ai-persistence` still held at 0.7.2 (0.8.1 and 0.8.3: the conformance kit still requires an `activities` store — `AIPersistence conformance: store 'activities' is missing`). 2026-10-10 re-bump: `ai` 7.0.137, `@tanstack/ai` 0.68.0, `-memory` 0.2.13, `-client` 0.39.2, `-openai` 0.29.1, `-react` 0.30.3, `@ai-sdk/openai` ^4.0.91, `@ai-sdk/provider` ^4.0.26.
- **The 0.72.1 → 0.74.0 bump (2026-10-08) is EXTENSION-ONLY again** (same reason: `packages/eve` still imports the removed
  `MutableNetworkSandboxSession`, `TS2305` in `src/sandbox.ts`/`sandbox.test.ts` on 0.74.0; `packages/eve` + `examples/eve-demo` stay on 0.65.0). The rebuild re-stamps
  **tool 76→78, dynamicTool 72→73, hook 38→39**; only 0.74.0 accepts them (verified by building the packed dist against a consumer on each of
  0.72.0/0.72.1/0.73.0 — all fail `eve build` — and 0.74.0, which mounts clean), so the floor moved `>=0.72.0` → **`>=0.74.0`**. Published 0.15.0 fails on 0.74.0 as on 0.72.x.
  Also bumped: `ai` 7.0.133, `@tanstack/ai` 0.65.1, `-client` 0.38.0, `-react` 0.30.0; `@tanstack/ai-persistence` still held at 0.7.2 (above).
- **The 0.69.0 → 0.72.1 bump (2026-10-07) is EXTENSION-ONLY** (`packages/eve` still imports the removed
  `MutableNetworkSandboxSession`; verified on 0.71.2 and 0.72.1: `TS2305` in `src/sandbox.ts`/`sandbox.test.ts`; needs a
  source change, so `packages/eve` + `examples/eve-demo` stay on 0.65.0). The rebuild re-stamps
  **tool 71→76, dynamicTool 68→72, hook 35→38**; read off every 0.69.0–0.72.1 tarball's
  `extension-compatibility.js`: 0.70.0–0.71.3 accept tool 73/dynamicTool 70/hook 37 (not 76/72/38), and **0.72.0+ accepts
  only tool 76** (+ the old 35), so the floor moved `>=0.69.0` → **`>=0.72.0`**. Published 0.15.0 (71/68/35) builds clean
  on eve 0.69–0.71.3 but **fails `eve build` on 0.72.x** (`Selected module binding "extensions/agentkit.ts" has no compile
  or runtime usage.`), verified in a fresh npm consumer with `eve@0.72.1`.
  Also: `@tanstack/ai-persistence` stays at 0.7.2 (devDep) because 0.8.0's conformance suite now requires an `activities`
  store (`ActivityStore`) or `skip: ['activities']` — a test/source change, not a bump.
- **The 0.68.0 → 0.69.0 bump (2026-10-01) is EXTENSION-ONLY, for the same reason as 0.68.0.** eve 0.69.0
  **dropped tool 59, dynamicTool 56 and hook 29** — exactly the stamps of published
  `@upstash/agentkit-eve-extension@0.14.0` (built with 0.68.0) — one day after it shipped, while its peer
  `>=0.68.0` still admitted 0.69.0: a fresh `npm i eve@latest @upstash/agentkit-eve-extension@latest`
  installed clean and then failed `eve build` with the obtuse *"Selected module binding
  "extensions/agentkit.ts" has no compile or runtime usage."*. eve's `dropped` reasons: tool 59 — "Workflow
  tools no longer accept execution or return background task receipts…"; dynamicTool 56 / hook 29 —
  "Background task execution was removed…". No source change: the rebuild re-stamps **tool 59→71,
  dynamicTool 56→68, hook 29→35**, and the floor moved `>=0.68.0` → **`>=0.69.0`** — read off every
  0.65.0–0.69.0 tarball's `extension-compatibility.js` (only 0.69.0 accepts any of 71/68/35) and proven
  with the packed tarball in fresh npm consumers: 0.69.0 builds and mounts every tool + the hook; 0.68.0
  is refused at install (`ERESOLVE … peer eve@">=0.69.0"`) and, forced with `--legacy-peer-deps`,
  fails `eve build` with the same obtuse error. eve 0.69.0's `ai` peer is still `^7.0.105`.
  `packages/eve` still cannot move: `MutableNetworkSandboxSession` (below) is still imported.
- **The 0.65.0 → 0.68.0 bump (2026-09-30) is EXTENSION-ONLY again.** `packages/eve` cannot take it
  without a source migration: eve **0.66.0** (ee286fe) removed `MutableNetworkSandboxSession` from
  `eve/sandbox` (network policy became provider-specific; `SandboxSession` lost `setNetworkPolicy`), and
  `packages/eve/src/sandbox.ts` + `sandbox.test.ts` import it — tsup's DTS step and `tsc` fail with
  `TS2305 … has no exported member 'MutableNetworkSandboxSession'` plus a cascade of implicit-`any`
  errors. (Knock-on: `examples/eve-demo`'s `next build` then fails on implicit-`any` in
  `agent/channels/eve.ts`, because `@upstash/agentkit-eve` has no `.d.ts`.) The extension needed no source
  change: its rebuild re-stamps **tool 55→59, dynamicTool 52→56, hook 25→29**, and the floor moved
  `>=0.65.0` → **`>=0.68.0`**, read off each 0.65.0–0.68.0 tarball's
  `dist/src/compiler/extension-compatibility.js`. eve 0.68.0 still accepts the old 55/52/25 stamps, so
  published `0.13.0` keeps working on it. eve ≥0.64's scaffold also needs `just-bash` for a plain
  `eve build`; the extension demo side-steps that with `--skip-sandbox-prewarm` (see its section).
- **The 0.64.1 → 0.65.0 bump (2026-09-23, same PR #46) finished what 0.64.1 couldn't: the whole repo
  is on 0.65.0 and every package requires it.** `packages/eve`'s sandbox was ported from the removed
  backend API to an eve **provider** (`UpstashSandbox`, see Known issues) — the only source change;
  memory/tools/auth/search needed none. `@upstash/box` moved `^0.5.1` → **`^0.7.5`** (peer `>=0.5.0` →
  **`>=0.7.1`**, the first release with `exec.session`, measured by grepping each 0.5.0–0.7.5 tarball's
  `client.d.ts`). The extension rebuild on 0.65.0 re-stamps **tool 54→55** (dynamicTool 52, hook 25
  unchanged) — 0.65.0 is the first eve accepting tool 55, so its floor is `>=0.65.0` whichever way you
  derive it (the decision to require latest eve everywhere and the manifest agree). eve 0.65.0's own
  breaking changes (the `todo` tool removed, `ask_question` no longer a default tool, `ctx.ask()`
  result shape) touch nothing here. Verified: lint, typecheck, build, 155/155 tests (with live Redis
  and live Box), both example builds (eve-demo also without any Box/Redis env: `next build` does not
  prepare sandboxes), both mocked-model evals, plus the out-of-repo sandbox e2e described under Known
  issues.
- **The 0.63.0 → 0.64.1 bump (2026-09-23) is EXTENSION-ONLY, and the first bump the whole repo could not take.**
  eve 0.64.0 dropped **tool 53, dynamicTool 51 and hook 24 in a single release** — precisely the stamps the
  just-published `@upstash/agentkit-eve-extension@0.12.0` carries — while 0.12.0's peer `>=0.63.0` still
  admitted 0.64.x, so `npm i eve@latest @upstash/agentkit-eve-extension@latest` installed clean and then
  died on the first `eve build` with the usual obtuse *"Selected module binding "extensions/agentkit.ts"
  has no compile or runtime usage."*. **This is the third time the same trap fired** (0.10.0 on eve 0.63.0,
  0.11.0's zod dedupe, now 0.12.0 on eve 0.64.0) — the lesson each time is the same: after ANY release,
  re-install the published tarball against `eve@latest` in a scratch consumer and run a real turn.
  The rebuild re-stamps **tool 53→54, dynamicTool 51→52, hook 24→25** (`builtWithEve` 0.64.1) and moves the
  floor `>=0.63.0` → **`>=0.64.0`** — measured, not read off the tables: the rebuilt dist packed into real
  npm consumers **fails on 0.63.0** (same obtuse error) **and builds on 0.64.0/0.64.1**, and with the new
  floor npm refuses the 0.63.0 install up front with
  `ERESOLVE … peer eve@">=0.64.0" from @upstash/agentkit-eve-extension@0.12.0`.
  **`packages/eve` deliberately stayed on 0.63.0** — see the sandbox-provider note under Eve framework
  facts; bumping it is a source migration, not a pin bump. There is a **stale branch
  `chore/eve-0.64.1-extension-only` (96bb264)** on origin that attempted this fix from *before*
  `ae3db83` (the zod widen): do not merge or build on it — it would regress `zod` back to the exact pin
  `4.4.3` and re-break the search tools.
- **The 0.55.0 → 0.63.0 bump (2026-09-20) is the first eve bump that fixes a real break, and the first
  that needed source changes.** eve went 0.55.0 → **0.63.0** in five days (0.56–0.58, 0.59.0/0.59.1, 0.60.0/
  0.60.1, 0.61.0/0.61.1, 0.62.0, 0.63.0). Three things happened at once:
  (1) **eve 0.63.0 (2026-09-19) dropped `dynamicTool` 29** — the stamp published `0.10.0` (built with
  0.52.2) carries — so a fresh `npm install eve@latest @upstash/agentkit-eve-extension@latest` consumer
  installs (the `>=0.55.0` floor lets it) and then fails `eve build` with the usual obtuse *"has no compile
  or runtime usage"*. 0.55.0 through 0.62.0 all still accepted tool 30 / dynamicTool 29 / hook 20; 0.63.0 is
  the first release that does not, eleven days after `0.10.0` shipped. The rebuild re-stamps **tool 38→53,
  dynamicTool 37→51, hook 22→24** and moves the floor `>=0.55.0` → **`>=0.63.0`** (0.62.0 rejects the new
  stamps — proven by packing the rebuilt dist into real eve consumers on 0.62.0 and 0.63.0).
  (2) **eve 0.59.0 made dynamic-tool schemas durable** (`7973fa2`: resolvers are replayed from a JSON
  snapshot, so a *live* schema captured from the resolver is rejected at `session.started` with
  *"callback "inputSchema" has a non-serializable capture"*, logged as `[eve:dynamic-tools] … skipping its
  complete result` — and the tool silently never mounts). Our `search`/`search_aggregate`/`search_count`
  handed eve the live zod schema core builds from the consumer's `search.schema`, so on eve 0.59–0.62 the
  extension mounted but its three search tools vanished at runtime, with `eve build` green. The fix is in
  `extension/tools/search*.ts`: compute `z.toJSONSchema(defs.<tool>.inputSchema)` into a resolver-local
  variable and pass THAT — plain JSON Schema data needs no durable factory and eve rehydrates it into its
  own validator. ⚠️ Writing `inputSchema: z.toJSONSchema(defs.search.inputSchema)` *inline* does NOT work:
  the compiler transforms inline schema expressions into factories and snapshots their captures, and `defs`
  is not JSON. `eve build` never resolves dynamic tools, so **only a turn that calls one proves it mounted**
  — `examples/eve-extension-demo`'s mock model now calls `agentkit__search_count` after `save_memory`, and
  the smoke eval gates on it (verified: reverting the fix fails exactly that gate, 3/4).
  (3) **eve 0.59.0 replaced the eval API** (`6ddfa9b`): `EveEvalContext` lost the session driver —
  `t.reply`/`t.newSession()` are gone, `t.send()` opens a FRESH session per call and returns an
  `EveEvalTurn` (`turn.message`, `turn.calledTool(…)`, `turn.session`), and `await t.session()` makes an
  explicit one for multi-turn conversations. Both evals were migrated; `memory.eval.ts` threads all five
  turns through ONE `t.session()` because eve-demo's mock model counts `userMessages` against `toolResults`
  in the accumulated prompt — repeated `t.send()` would compile, run, and test something else.
  eve's `ai` peer moved to `^7.0.105`, so the repo-wide pin went **`7.0.101` → `7.0.107`** (+ `pnpm -r
  update "@ai-sdk/*"`, one `ai@7.0.107` in the lockfile). `packages/eve`'s peer stayed **`>=0.32.0`** and
  it ships **no changeset**: its `dist` is **byte-identical** to published `0.9.0`. Test-baseline note: on a
  pay-as-you-go database `vitest run` is **142 passed / 6 skipped / 0 failed** — the "11 failures" earlier
  automated runs reported were the free `start-redis` database's 1-search-index cap, not eve.
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
- **It has a mocked-model e2e eval now** (`evals/memory.eval.ts` + `evals/evals.config.ts`), run with
  `AGENTKIT_MOCK_MODEL=1 npx eve eval` from the demo dir — no `OPENAI_API_KEY` needed, real Redis.
  `agent/agent.ts` swaps in eve's `mockModel` under that env var (same pattern as eve-extension-demo).
  The mock is *prompt-aware*: `MockModelRequest.messages` exposes what eve injected, so echoing it is
  how the eval asserts on **automatic** memory recall. Watch out: `toolResults` lists every tool
  result in the prompt, not just this turn's — script against a count, not `length > 0`.
  **Eval API (eve ≥0.59):** `t.send()` opens a FRESH session per call and returns an `EveEvalTurn`
  (`turn.message` is the reply, `turn.succeeded()`/`turn.calledTool()` its assertions); `t.reply` and
  `t.newSession()` no longer exist. A multi-turn conversation needs one explicit `await t.session()` and
  `session.send()` for every turn — `memory.eval.ts` does exactly that, because the prompt-aware mock
  only works when all five turns share one accumulated conversation.
  `eve eval` works fine in this demo despite its sandbox: nothing opens a Box during an eval, so no
  `UPSTASH_BOX_API_KEY` is needed. CI runs it. **An eval file can talk to Redis itself** —
  `Redis.fromEnv()` resolves inside the eval runner (it loads the project `.env`), so an eval can
  assert on *persisted state* and not just on the reply; `memory.eval.ts` tags its fact with a
  per-run nonce and scans `agentkit:memory:*` for it, so a document left by an earlier run can't
  make the gate pass.
- **Two eve memory slots live in `agent/memory/`** (`profile.ts` = `fileMemory({ backend:
  redisDocuments() })`, `recall.ts` = `redisMemory()`), both `scope: byPrincipal`. Slots are
  agent-owned — an extension cannot contribute them. **`byPrincipal` fails closed** (null for
  anonymous/runtime → slot disabled) where the old `?? ctx.session.id` fallback failed open into a
  per-session partition. It still keeps alice/bob separate because `demoUserAuth` runs **before**
  `localDev()` in `agent/channels/eve.ts`, so the UI's `x-user-id` header supplies the principal;
  the eve TUI sends no header and lands on the shared `local-dev` principal. That header is
  demo-only — anyone can set it, so it is not a real tenant boundary.
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
- **Its build script is `eve build --skip-sandbox-prewarm` since eve 0.64.** eve 0.64 prewarms a
  sandbox template by default even for a scaffold with no `sandbox/` directory, and its default provider
  is **just-bash**, which eve does not bundle — a plain `eve build` dies with *"The just-bash sandbox
  provider requires the `just-bash` package, which is not bundled with eve"* / `Cannot find package
  'just-bash'`. On eve 0.63.0 the same project builds with no flag. The alternative is adding
  `just-bash` as a devDependency; the flag is used here because this demo has no sandbox to prewarm.
  `eve eval` is unaffected — it never prewarms.
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
  A second flavour of the same error: pnpm 11 **did** download 11.5.3 into
  `~/.local/share/pnpm/.tools/pnpm/11.5.3/` but its `bin/*` symlinks point at a `…_tmp_<pid>` path
  under a *different* home prefix (e.g. `/workspace/home/...` when `$HOME` is `/home/boxuser`), so they
  dangle and every pnpm invocation still ENOENTs. Repoint them at the real files that are already there:
  ```bash
  D=~/.local/share/pnpm/.tools/pnpm/11.5.3
  ln -sf $D/node_modules/pnpm/bin/pnpm.mjs $D/bin/pnpm; ln -sf $D/node_modules/pnpm/bin/pnpm.mjs $D/bin/pn
  ln -sf $D/node_modules/pnpm/bin/pnpx.mjs $D/bin/pnpx; ln -sf $D/node_modules/pnpm/bin/pnpx.mjs $D/bin/pnx
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

### Verifying a consumer install (the only way to catch dependency-resolution bugs)
Every in-repo check runs against `pnpm-lock.yaml`, so it cannot see how a *consumer's* resolver will
lay out our dependencies — that blind spot is what hid the dual-zod bug. When you change any
`dependencies`/`peerDependencies` of a published package, verify in a real scratch consumer:
```bash
cd packages/eve-extension && pnpm pack --pack-destination /tmp     # rewrites workspace:* -> the real version
mkdir /tmp/c && cd /tmp/c                                          # scaffold: package.json (type:module,
                                                                   # imports {"#*":"./agent/*","#evals/*":"./evals/*"}),
                                                                   # agent/agent.ts, agent/channels/eve.ts,
                                                                   # agent/extensions/agentkit.ts, evals/
npm install eve@latest /tmp/upstash-agentkit-eve-extension-*.tgz \
  @upstash/redis @ai-sdk/openai ai zod @vercel/connect
```
Copy `examples/eve-extension-demo`'s `agent/agent.ts` (the `AGENTKIT_MOCK_MODEL` scripted `mockModel`)
and its `evals/agentkit-smoke.eval.ts`, then `AGENTKIT_MOCK_MODEL=1 npx eve eval`. **`eve build` passing
proves almost nothing** about dynamic tools — only a turn that *calls* one does.
Two cheap, Redis-free checks worth running first:
```bash
# 1. how many copies of a dep does the consumer actually have, and who gets which?
find node_modules -path "*/zod/package.json" | while read f; do echo "$f $(node -p "require('./$f').version")"; done
# 2. does the extension's zod convert the sdk's schema? (reproduces the dual-instance break in ~1s)
#    import createSearchToolDefs from the consumer's sdk, then call the EXTENSION's zod
#    toJSONSchema(defs.search.inputSchema) -> "Cannot read properties of undefined (reading 'push')" == two instances
```
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
- **eve `./sandbox` — `UpstashSandbox` provider** (`packages/eve/src/sandbox.ts`, eve ≥0.64 contract,
  `@upstash/box` ≥0.7.1). `UpstashSandbox = defineSandboxProvider({ name: "upstash", environment })`;
  users write `export const environment = UpstashSandbox.environment({...})` and
  `export default defineSandbox(() => environment.open())`. Options = `Omit<BoxConfig, "networkPolicy" |
  "name">` + `prepare(sandbox)` + `baseSnapshot`. Mapping:
  **`prepare(ctx)`** (runs at `eve build`, lazily on first access under `eve dev`, in the build process)
  → temp box, write `ctx.resources` (workspace tree → `/workspace`, skills tree → literal
  `$HOME/.agents/skills`, expanded by running `printf %s "$HOME"` in the box), run the user hook,
  `box.snapshot()`, delete the temp box, return `{ snapshotId }` (or `{ snapshotId: null }` and **no box**
  when there's nothing to bake). eve persists that artifact in the build output — **so the old Redis
  template registry is gone** (and with it the `redis`/`templatePrefix`/`enableTelemetry` options).
  **`start(ctx, open, artifact)`** → `Box.fromSnapshot` (or `baseSnapshot`, or `Box.create`), deny-all at
  creation, then `open.networkPolicy` if given; returns state `{ boxId, version: 1 }`. A missing
  prepared snapshot **throws** ("rebuild or redeploy") — Box reports it as "Snapshot is not ready" —
  instead of falling back to an empty box. Box names are account-unique, so each start names its box
  `eve-<sha256(session.id)[:12]>-<random6>`; `name` is therefore excluded from the options (the old
  backend passed a user `name` straight to `Box.create`, which would have collided on the 2nd box).
  **`resume(ctx, artifact, state)`** → `Box.get(boxId)` **plus `getStatus()`**: `Box.get` *resolves* for a
  deleted box (its record lingers with `status: "deleted"`), so without the status check resume
  handed eve a dead box — caught by the live test. A gone box throws (eve's contract: resume must not
  recreate); `sandbox.delete()` is how a session gets a fresh one. **Handle:** `onSessionStop` →
  `pause()` (rejects on failure), `onRuntimeShutdown` → `pause()` (swallowed), `onSessionDelete` →
  `box.delete()` (honours an already-aborted signal; a `deleted` flag makes repeat teardown a no-op).
  The snapshot is shared by every session of the environment and is never deleted by a session.
  **Session:** `run`/`spawn` use Box's **`exec.session`** (WebSocket; ≥0.7.1): streamed, *separate*
  stdout/stderr, env as `KEY=VALUE` (reaches every command in a `&&` chain — the old `K=v cmd` prefix
  did not), cwd, and **kill on eve's abort signal** (eve binds the turn's signal to every session call;
  the old buffered `exec.command` could not cancel). eve's built-in `bash`/`glob`/`grep` call `run`,
  `read_file`/`write_file` call `readTextFile`/`writeTextFile`. Paused boxes auto-resume on exec.
  Network policy lives on the box (survives pause/resume), so the old "re-apply the persisted policy on
  every open" workaround is gone. **Path bridge** unchanged: `toBoxPath`/`rewriteWorkspacePaths` map
  `/workspace` → `/workspace/home`. **Known limitation:** each `eve build` with something to prepare
  mints a new snapshot (Box has no snapshot lookup by name), so old snapshots accumulate.
  **Verified 2026-09-23:** 17 offline + 3 live-Box tests in `sandbox.test.ts` (full prepare → start →
  stop → resume → delete cycle; spawn streaming/kill; abort; attachHeaders), plus an out-of-repo e2e:
  packed tarballs + eve 0.65.0, `eve build` prepared a snapshot, and a two-turn mocked-model `eve eval`
  had the built-in `bash` tool read the workspace seed, a skill and the `prepare` output, confirm
  deny-all egress, and read turn 1's file back in turn 2 (resume) — one Box per session, no leaked
  prepare boxes. That e2e is **not** in CI (it needs a Box key).
- ~~`gpt-5.4-mini` (demo model) may not exist~~ — verified live (2026-08): it exists and responds in
  both demos. No swap needed.
- The `19.2.17` `@types/react` may linger as an unpruned orphan in `.pnpm`; harmless (nothing links it).

## tanstack-ai (`packages/tanstack-ai`)

- **Entry points** (tsup + `exports`): `.` = everything that needs only `@tanstack/ai` (stream, locks,
  middleware, search, `RedisLock`/`EventLog`); `./persistence` (`src/persistence/index.ts`, needs
  `@tanstack/ai-persistence`) and `./memory` (`src/memory/index.ts`, needs `@tanstack/ai-memory`).
  Rule: **the root entry must never import types from an optional peer** — check `dist/index.d.ts`
  has no `@tanstack/ai-persistence` / `@tanstack/ai-memory` / `@upstash/blob` import after a build.
  (Copilot review on #48; verified 2026-09-28 with a consumer that has only `@tanstack/ai` and
  `skipLibCheck: false` — the only errors are two pre-existing ones inside `@tanstack/ai`'s own
  `spawn.d.ts`.)
- **Demo + E2E** (`examples/tanstack-ai-demo`): Next.js port of TanStack's `ts-react-chat` persistent-chat
  route onto our backends (detached run, `resumeServerSentEventsResponse`, `reconstructChat`, memory),
  with `RedisLock` replacing its process-local "one producer per run" set: `withLock(runId, fn,
  { acquireTimeoutMs: 0 })` (timeout = someone else produces it, just tail), lease renewed for the run,
  and on lease loss the run is aborted and the producer neither appends nor closes the log (the new
  owner may be writing). The producer promise goes to Next.js `after()` (+ `maxDuration`) so it
  survives the response on serverless; truly durable background runs (QStash) are a follow-up. `AGENTKIT_MOCK_MODEL=1` swaps in
  a scripted model (`lib/model.ts`: word-by-word stream, `remember:` → `save_memory`, echoes recalled
  memories). `pnpm e2e` (`e2e/`, files `*.e2e.ts` so root `pnpm test` skips them) starts **two** `next start`
  servers on free ports, one Redis, a per-run `DEMO_PREFIX`, and checks cross-instance resume, mid-run
  reconstruct, memory across threads, single production of a doubly-POSTed run, single production of
  a run that outlives its lease (`PRODUCER_LEASE_MS=1000` + a `long:` ~6s mock answer), and a 400 on a
  bad body. Count `TEXT_MESSAGE_START` to detect a second producer: two producers **interleave** their
  words in one log, so text regexes miss it (a no-renewal build passed a regex check and failed this).
  Gotchas hit building it: AG-UI bodies need a message `id`; Next.js route handlers don't return a thrown
  `Response` (catch `chatParamsFromRequest`'s 400 yourself); spawn `node_modules/.bin/next` detached and
  kill the process group (killing `npx` orphans `next`); backends are created lazily so `next build`
  needs no credentials. CI runs it after "Build example apps"; skipped without Redis secrets.
- **`src/package-exports.test.ts`** pins `package.json#exports` to the tsup entries — added after a
  pushed commit shipped `dist/persistence.js` without exporting it (only the demo's build caught it).
- **Layout** (`src/`): one folder per feature — `persistence/` (stores, `records.ts` plumbing,
  `blob-store.ts`), `stream/` (`upstashStream` + `EventLog`), `locks/` (`upstashLocks` + `RedisLock`),
  `memory/`, `middleware/`, `search/`, and `testing/` (scripted adapter, test bucket, env helpers —
  never imported by `index.ts`). Root: `index.ts`, `telemetry.ts`, `version.ts`, `integration.test.ts`.
- **Redis primitives** (`src/locks/redis-lock.ts`, `src/stream/event-log.ts`; moved here from core 2026-09-28, exported from this package): `RedisLock` (+ `LockLease`, `LockAcquireTimeoutError`,
  `LockLostError`) — `SET NX PX` lease + a never-expiring `INCR` fencing counter, release/extend are
  ownership-checked Lua; `withLock` renews every `leaseMs/3` and aborts the section's signal on loss.
  `EventLog` (+ `LogEntry`, `EventLogClosedError`) — Redis Streams: `append` is one `EVAL` script of `XADD`s (atomic,
  ordered ids) that refuses a closed log and refreshes the stream TTL,
  `read` resumes with an **exclusive** `XRANGE (id` and tails by polling (REST keeps no blocking
  reads), `close` sets a separate `:closed` key and readers do a final drain after seeing it, so
  nothing appended before close is lost. Values carry an `agentkit-event-v1:` marker because
  `@upstash/redis` auto-deserializes stream fields (`"123"` would come back as `123`). Both verified
  live over REST (2026-09-27): `MULTI`+`XADD`, `XRANGE (`, `EVAL`, `SET NX PX` all work.
- **Why it exists:** TanStack AI (≥0.61) defines backend contracts for production state and ships
  only in-memory implementations (`memoryPersistence`, `memoryStream`, `InMemoryLockStore`,
  `InMemoryRunStore`, the ai-memory `inMemory()`/ioredis-shaped `redis()` adapters). As of 2026-09
  there were no Redis/Postgres persistence backends on npm. This package fills the seams; it does
  **not** wrap models or reinvent TanStack features.
- **Already upstream, don't duplicate:** `@tanstack/ai-sandbox-upstash-box` (Box sandbox provider)
  is TanStack's own package.
- Exports: `upstashPersistence` (messages/runs/interrupts/metadata), `upstashStream`
  (`StreamDurability`, offsets `upstash:v1:<encodeURIComponent(runId)>:<streamId>`), `upstashLocks`
  (`LockStore` over `RedisLock`, `src/locks/`), `upstashMemory` + `memoryScopeKey` (`MemoryAdapter` over core
  `AgentMemory`), `toolCache`/`rateLimit` middlewares + `RateLimitExceededError`, `createSearchTools`
  (returns a `Tool[]` built with `toolDefinition().server()`), re-exported `createRateLimit`/`Ratelimit`.
- **Peers:** `@tanstack/ai` required; `@tanstack/ai-persistence` and `@tanstack/ai-memory` optional
  (only their *types* are imported, so the runtime never needs them). `@tanstack/ai` is pinned exactly
  as a devDep (0.61.0) — TanStack AI is pre-1.0 and moves fast; re-run the conformance suite on bumps.
- **Persistence layout** (`agentkit:tanstack:*`): every record (run, interrupt, generation run,
  artifact, blob record, metadata value, transcript) is a **RedisJSON document**, so values keep their
  JSON types and need no codec. Shared plumbing is in `src/records.ts`:
  - `CREATE`: `JSON.SET … NX` + `ZADD` into each index, returns the stored doc (idempotent
    `createOrResume`). `PATCH`: `EXISTS` guard (a bare `JSON.MERGE` on a missing key *creates* it,
    verified live 2026-09-28) then `JSON.MERGE`.
  - `toMergePatches` turns `{...existing, ...patch}` semantics into two merge patches: a key present
    with `undefined` becomes `null` (merge-patch delete); object-valued fields are nulled in the first
    patch and set in the second, because merge patches *merge* nested objects instead of replacing
    them. A literal `null` in a patch therefore deletes the field.
  - `checkRun` validates run status at read time (TanStack's readers act destructively on it).
- Indexes: `threadRuns:<id>`/`parentRuns:<id>` (zset by `startedAt`), `detachedRuns` (by
  `detachedSince`, a **candidate** list — `listReclaimable` re-checks each record),
  `threadInterrupts`/`runInterrupts` (by `requestedAt`), `threadGenerationRuns`,
  `runArtifacts`/`threadArtifacts` (by `createdAt`, ties byte-ordered like the reference store).
  `commitBatch` checks every interrupt is present and pending (`JSON.GET $.status`) and applies all
  patches in one script.
- Artifacts: which indexes a doc is in lives in a side hash `artifactIndexes:<id>` (raw index-key
  strings) so the doc stays exactly the record. Re-saving under another run/thread: the caller reads
  the side hash, declares the old index keys (required by `allow-key-locking`), and the script
  compare-and-swaps, retrying on a race.
- Metadata: one doc per pair, key `meta:<encodeURIComponent(ns)>:<encodeURIComponent(key)>`, value
  wrapped as `{ v }` so a bare string round-trips.
- **Blobs** (`blob-store.ts`, only when `upstashPersistence({ bucket })`): bytes in Upstash Blob at an
  immutable **versioned** path `<pathPrefix><encodeURIComponent(key)>/<uuid>`; `blobVersion:<key>` points
  at the current one and is swapped in the same script as the record (`PUT_RECORD` returns the replaced
  path, deleted after commit; `DELETE_RECORD` likewise), and `get` reads record + pointer in one
  `MULTI`, so concurrent puts can never leave a record describing another writer's bytes; the record is a JSON doc plus a lexical zset of keys.
  `PUT_RECORD` replaces the doc but restores the old `createdAt` (read via `JSON.GET $.createdAt`).
  Blob listings omit content type + metadata, hence records in Redis. Ranges use `signedReadUrl` +
  `Range`; a 200 is sliced locally. `@upstash/blob` is an optional peer (structural
  `BlobBucketLike`). Live-Blob conformance runs with `UPSTASH_BLOB_TOKEN` (get it via the MCP's
  `blob_bucket get` + `include_credentials`): 26/26 on 2026-09-28.
- **Config types reuse the primitives and core:** `UpstashLocksConfig = Omit<RedisLockConfig, "redis"> & {redis?}`,
  `UpstashStreamConfig` from `EventLogConfig`, `ToolCacheMiddlewareConfig` from `ToolCacheConfig`,
  `UpstashMemoryConfig` picks from `AgentMemoryConfig`, `CreateSearchToolsConfig` from
  `SearchToolDefsConfig` — spread straight through, no per-field copying.
- **Memory:** own keyspace `agentkit:tanstackMemory` (its schema adds an indexed `source` field, so
  it must not share `agentkit:memory` — see the eve memory-slot notes on why). Scope → `userId` via
  `memoryScopeKey`: per user across threads by default, parts escaped so `.`/`_`/`:` can't forge a
  collision. Recalled lines are labelled by source like eve's `redisMemory()`.
- **Testing:** `persistence.test.ts` runs TanStack's `runPersistenceConformance` (from
  `@tanstack/ai-persistence/testkit`; it declares a vitest ^4 peer but runs fine on the repo's vitest
  2) with a fresh prefix per case — all seven stores, nothing skipped, 26/26 on 2026-09-27. `memory.test.ts` also runs
  `runMemoryAdapterContract` (`@tanstack/ai-memory/testkit`), each scope pinned under a unique
  tenant — it needs `waitForIndexing` (save provisions the index once, writes, then waits), exactly
  like eve's `redisMemory()` capture. Middleware/memory/search tests drive a real
  `chat()` agent loop through `src/test-adapter.ts` (a scripted `TextAdapter` emitting AG-UI
  `TOOL_CALL_*`/`TEXT_MESSAGE_*`/`RUN_FINISHED` chunks) — no model provider needed.
- **Not built yet (proposed):** Code Mode isolate driver on Box (port of `@tanstack/ai-isolate-daytona`'s
  need_tools/replay loop), Redis `SandboxInstanceStore`/`SandboxCheckpointStore` (+ Upstash Blob
  `BlobStore`), QStash-backed background runs writing to `upstashStream`, and a QStash schedule for
  `reapDetachedRuns`. 
