# @upstash/agentkit-eve

[Upstash AgentKit](https://upstash.com/) for **Eve, the Vercel agent framework**. Drop-in pieces for
your `agent/` tree: memory tools, Redis-Search tools, a rate-limit gate, an
[Upstash Box](https://github.com/upstash/box) sandbox backend, and cached tools.

```bash
pnpm add @upstash/agentkit-eve @upstash/redis
# in your app (Eve + the OpenAI provider, plus Box only if you use /sandbox):
pnpm add eve @ai-sdk/openai @upstash/box
```

## Memory tools

Long-term memory the model reads and writes itself — `recall_memory` and `save_memory`, one file each.

```ts
// agent/tools/recall_memory.ts
import { defineMemoryRecallTool } from "@upstash/agentkit-eve";

export default defineMemoryRecallTool({
  userId: (_, ctx) => ctx.session.auth.current?.principalId ?? ctx.session.id,
});
```

```ts
// agent/tools/save_memory.ts
import { defineMemorySaveTool } from "@upstash/agentkit-eve";

export default defineMemorySaveTool({
  userId: (_, ctx) => ctx.session.auth.current?.principalId ?? ctx.session.id,
});
```

<details>
<summary>Options &amp; the <code>userId</code> tenant boundary</summary>

- **`userId`** _(required)_ — a string, or `(input, ctx) => string`.
- `topK` — max memories `recall` returns.
- `minScore` — BM25 relevance floor.
- `redis` — defaults to `Redis.fromEnv()`.

`userId` is the only tenant boundary (required, non-empty, no `:`). Derive it from eve's **verified
session auth** — `ctx.session.auth.current?.principalId` — not from anything the client supplies.
Configure a real authenticator (`vercelOidc()`, an OIDC/JWT provider like Clerk, …) so `principalId`
is trustworthy; the `?? ctx.session.id` fallback only applies to unauthenticated requests. Memories
are stored at `agentkit:memory:<userId>:<id>`.

</details>

## Search tools

`search` / `aggregate` / `count` over an Upstash Redis Search index; the model-facing descriptions are
generated from your schema.

```ts
// agent/tools/search_books.ts
import { s } from "@upstash/redis";
import { defineSearchTools } from "@upstash/agentkit-eve";

export default defineSearchTools({
  schema: s.object({ title: s.string(), author: s.string().noTokenize(), year: s.number() }),
  indexName: "books",
}).search; // aggregate_books.ts → .aggregate, count_books.ts → .count
```

<details>
<summary>Options &amp; the one-file-per-tool rule</summary>

- **`schema`** _(required)_ — built with `s` from `@upstash/redis`.
- `indexName` — defaults to `"agentkit:search"`; ties all three tools to one index.
- `prefix` — key prefix for indexed JSON docs (defaults to `"<indexName>:"`).
- `defaultLimit` — default page size for `search` (10).
- `redis` — defaults to `Redis.fromEnv()`.

Each tool file must be self-contained, so call `defineSearchTools` in each one and export the member
you want — repeat the same `schema` + `indexName` across `search_books.ts` / `aggregate_books.ts` /
`count_books.ts`. The index is created reactively on first use, and each returned tool is already
`defineTool`-branded.

</details>

## Rate limiting

A ready `AuthFn` that throttles inbound requests — drop it into your channel's `auth` walk ahead of
your real authenticators.

```ts
// agent/channels/eve.ts
import { createRateLimitAuth, Ratelimit } from "@upstash/agentkit-eve";
import { localDev, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  auth: [
    createRateLimitAuth({
      limiter: Ratelimit.slidingWindow(20, "1 m"),
      identifier: (req) => req.headers.get("x-forwarded-for") ?? "anonymous",
    }),
    localDev(),
    vercelOidc(),
  ],
});
```

<details>
<summary>Options, the required <code>identifier</code> &amp; POST-only counting</summary>

- **`limiter`** _(required)_ — e.g. `Ratelimit.slidingWindow(20, "1 m")` or `fixedWindow(...)`.
- **`identifier`** _(required)_ — a string, or `(request) => string`. There's no implicit `"global"`:
  one shared bucket lets a single abusive caller exhaust the window for everyone, so derive it per
  request (an auth user id, an API key, or `x-forwarded-for` for per-IP).
- `prefix` — base key prefix; keys are `<prefix>:<identifier>` (default `agentkit:rateLimit`).
- `message` — 403 body when over the limit.
- `redis` — defaults to `Redis.fromEnv()`.

It's a _gate_: under the limit it returns `null` to fall through to the next `AuthFn`; over it throws a
403. **Only `POST` requests are counted** — eve runs each turn as a message `POST` plus a follow-up
`GET …/stream`, and the auth walk runs on both, so counting only the `POST`s means one turn costs one
token (a `slidingWindow(20, "1 m")` allows 20 turns/min, not 10).

</details>

## Code-execution sandbox

A drop-in replacement for Eve's `vercel()` backend, powered by Upstash Box — swap the import and keep
the rest of your [sandbox file](https://eve.dev/docs/sandbox) the same.

```ts
// agent/sandbox.ts
import { defineSandbox } from "eve/sandbox";
import { upstash } from "@upstash/agentkit-eve/sandbox"; // was: eve/sandbox/vercel

export default defineSandbox({
  backend: upstash({ runtime: "node", size: "medium" }),
  revalidationKey: () => "repo-bootstrap-v1",
  async bootstrap({ use }) {
    const sandbox = await use({ networkPolicy: "allow-all" }); // open egress to install packages
    await sandbox.run({ command: "apt-get install -y jq" });
  },
  async onSession({ use }) {
    await use(); // inherits the secure deny-all default
  },
});
```

<details>
<summary>Config — it's Box's <code>BoxConfig</code></summary>

`upstash(config)` takes the `@upstash/box` `BoxConfig` verbatim — whatever you'd pass to
`Box.create({...})`: `runtime`, `size`, `apiKey` (defaults to `UPSTASH_BOX_API_KEY`), `keepAlive`,
`initCommand`, `env`, `skills`, `mcpServers`, `timeout`, … — plus an optional `redis` (defaults to
`Redis.fromEnv()`). `networkPolicy` is **not** a config knob (see below).

`@upstash/box` is an optional peer dependency — only needed when you import
`@upstash/agentkit-eve/sandbox`.

</details>

<details>
<summary>Security — network egress is deny-all by default</summary>

The sandbox runs untrusted, model-generated code, so open egress would mean SSRF / data exfiltration /
reaching your own infrastructure from inside the box. Open it per-session — in `bootstrap`'s `use(...)`
or the session `use(...)` — never as a config knob. Note that `env` passed to `upstash({ env })` is
readable by code running in the box; don't pass secrets you wouldn't want it to see.

</details>

<details>
<summary>Lifecycle — one box per conversation, Redis template registry</summary>

**Reuse** — eve re-opens a session several times per turn; the backend reattaches to the same Box
instead of creating a new one each time. Boxes default to Box's pause-based idle lifecycle
(`keepAlive: false`) — auto-paused when idle, resumed on reattach, reaped by Box. Pass `keepAlive: true`
only for an always-running box you manage yourself.

**Template registry** — eve builds your template (seed files + `bootstrap`) at build/startup, but
session creation runs per request in a different process, so the snapshot id is stored in a durable
Redis registry (`redis`, defaulting to `Redis.fromEnv()`). Eve roots its tools at `/workspace` while a
Box session lives at `/workspace/home`; the backend bridges the two automatically.

</details>

## Cached tools

Like Eve's `defineTool`, but the `execute` result is memoized in Redis.

```ts
// agent/tools/get_weather.ts
import { z } from "zod";
import { defineCachedTool } from "@upstash/agentkit-eve";

export default defineCachedTool({
  description: "Get the current weather for a city.",
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ city }) => fetchWeather(city),
  toolName: "get_weather",
  userId: (_, ctx) => ctx.session.auth.current?.principalId ?? ctx.session.id,
});
```

<details>
<summary>Options</summary>

- `description` / `inputSchema` / `execute` — the usual `defineTool` fields; `execute`'s result is memoized.
- **`toolName`** _(required)_ — the tool segment of the cache key.
- **`userId`** _(required)_ — a string, or `(input, ctx) => string`; scopes the cache per user.
- `ttlSeconds` — per-result TTL (default: no expiry).
- `redis` — defaults to `Redis.fromEnv()`.

Keys are `agentkit:toolCache:<userId>:<toolName>:<hash>`.

</details>

## Working with eve's `agent/` files

eve's runtime snapshots each tool/channel/hook file and resolves only **package** imports from it — it
does **not** include shared `agent/`-source modules (e.g. a `agent/lib/redis.ts`). So inside `agent/`:

- Import only from packages, never from other `agent/` files.
- Lean on the defaults — **`redis` defaults to `Redis.fromEnv()`** in every helper, so you almost never pass it.
- Repeat config (schema, names) per file rather than sharing a module.

Shared app code (e.g. a seeder a page calls) lives in your project `lib/`, imported by the app — not by
`agent/` files.

## Testing

Tests run against a **real Upstash Redis** (and a real Box when `UPSTASH_BOX_API_KEY` is set); only LLM
calls are mocked. Set `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (suites skip when absent).

## License

MIT
