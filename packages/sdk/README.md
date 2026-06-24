# @upstash/agentkit-sdk

Core, framework-agnostic primitives for building AI agents on
[Upstash Redis](https://upstash.com/). No vector database required: the "semantic" features (memory
recall, search) run on [Upstash Redis Search](https://upstash.com/docs/redis/search/introduction) and
its `$smart` fuzzy operator (layered phrase / term / fuzzy / prefix matching, BM25-scored).

```bash
pnpm add @upstash/agentkit-sdk @upstash/redis
```

Every feature takes only the `@upstash/redis` client. The search-backed ones create and own their
Redis Search index internally:

```ts
import { Redis } from "@upstash/redis";
import { AgentMemory, ChatHistory, ToolCache } from "@upstash/agentkit-sdk";

const redis = Redis.fromEnv();
const history = new ChatHistory({ redis });
const memory = new AgentMemory({ redis });
const cache = new ToolCache({ redis });
```

## Chat history

Durable conversation transcripts on Redis Search, the source of truth for a chat. `saveChat` replaces
the whole message array; `getChat` / `listChats` / `searchChats` read it back.

```ts
await history.saveChat({ userId: "user-123", sessionId: "session-abc", messages, title: "Trip planning" });

const chat = await history.getChat({ userId: "user-123", sessionId: "session-abc" }); // or null
const chats = await history.listChats({ userId: "user-123", limit: 50 });
const hits = await history.searchChats({ userId: "user-123", query: "wireless headphones", target: "both" });
await history.deleteChat({ userId: "user-123", sessionId: "session-abc" });
```

<details>
<summary>Config, method options &amp; how it's stored</summary>

```ts
new ChatHistory<MyMessage>({
  redis,
  prefix: "agentkit:chat", // optional: base key prefix
  indexName: "agentkit_chat", // optional: Redis Search index name (defaults to the prefix)
  ttlSeconds: 60 * 60 * 24 * 30, // optional: per-chat TTL (default: no expiry)
  extractText: (messages) => ({ userMessages: "...", modelMessages: "..." }), // optional: override text extraction
});
```

- `searchChats` also takes `limit`, `minScore` (BM25 floor, default 0), and `target` (`"user"` | `"model"` | `"both"`).
- `saveChat` is an overwrite, not an append — pass the complete transcript (typically from the route's `onFinish`).

`ChatHistory<TMessage>` is generic over the message type (ai-sdk → `UIMessage`, eve → `EveMessage`).
Each chat is one JSON doc at `agentkit:chat:<userId>:<sessionId>` (keyed per user, so two users can't
collide on a `sessionId`), indexed over `userId` + `sessionId` (filters) and `userMessages` +
`modelMessages` (`$smart` text); the raw `messages` array rides along unindexed.

</details>

<details>
<summary>Security: <code>userId</code> / <code>sessionId</code> are the tenant boundary</summary>

Both are **required, non-empty, and may not contain `:`** (the key separator) — they're the only tenant
boundary, so an empty or separator-bearing value throws rather than silently mis-scoping a chat.
**Derive `userId` from a verified server-side auth source** (Clerk, Auth.js/NextAuth, Supabase Auth,
Auth0, …) — **never from a client-supplied header, query param, or body**, or a caller can impersonate
any user. A chat can't be read or overwritten under a different `userId`.

</details>

## Agent memory

Long-term, fuzzily-recalled memory scoped per user.

```ts
await memory.add({ text: "The user prefers TypeScript", userId: "user-123" });

const hits = await memory.recall({ query: "typescript preference", userId: "user-123", topK: 5 });
await memory.forget("pref-lang", { userId: "user-123" });
```

<details>
<summary>Config, method options &amp; the tenant boundary</summary>

```ts
new AgentMemory({
  redis,
  prefix: "agentkit:memory", // optional: base key prefix
  indexName: "agentkit_memory", // optional: Redis Search index name (defaults to the prefix)
  minScore: 0, // optional: default BM25 relevance floor for recall
});
```

- `add` takes an optional `id` (a stable id; generated when omitted).
- `recall` takes `topK` (default 5), `minScore`, and an optional `query` — omit it (or pass `""`) to return everything for the user.
- Stored at `agentkit:memory:<userId>:<id>`.

`userId` is **required, non-empty, and may not contain `:`** on every method — the only tenant boundary
for memory. **Derive it from a verified server-side auth source** (Clerk, Auth.js/NextAuth, Supabase
Auth, Auth0, …) — never a client-supplied value.

</details>

## Search tools

Framework-agnostic `search` / `aggregate` / `count` tool **definitions** over an Upstash Redis Search
index. This is how you do **RAG**: index your own documents, then hand the agent these tools (there's
no dedicated RAG primitive). The descriptions are generated from your schema.

```ts
import { s } from "@upstash/redis";
import { createSearchToolDefs } from "@upstash/agentkit-sdk";

const defs = createSearchToolDefs({
  schema: s.object({ name: s.string(), age: s.number(), city: s.string().noTokenize() }),
  redis,
  indexName: "users",
});
// defs.search / defs.aggregate / defs.count — each { description, inputSchema, execute }
```

<details>
<summary>Options &amp; how the adapters use it</summary>

- **`schema`** _(required)_ — built with `s`.
- **`redis`** _(required)_ — the Upstash Redis client.
- `indexName` — defaults to `"agentkit:search"`.
- `prefix` — key prefix for indexed JSON docs (defaults to `"<indexName>:"`).
- `defaultLimit` — default page size for `search` (10).

Each def is `{ description, inputSchema, execute }`; the ai-sdk adapter wraps them with `tool()`, the
eve adapter with `defineTool()`. The index is created reactively on first use (no setup step). For RAG,
index your docs as JSON under one prefix and hand the agent these tools (typo-tolerant `$smart`
retrieval, BM25-ranked).

</details>

## Rate limiting

A configured [Upstash Ratelimit](https://github.com/upstash/ratelimit-js). Call `.limit(identifier)`
before doing work and short-circuit when over the limit.

```ts
import { createRateLimit, Ratelimit } from "@upstash/agentkit-sdk";

const ratelimit = createRateLimit({ redis, limiter: Ratelimit.slidingWindow(20, "1 m") });

const { success } = await ratelimit.limit("user-123");
if (!success) throw new Error("rate limited");
```

<details>
<summary>Options</summary>

- **`limiter`** _(required)_ — e.g. `Ratelimit.slidingWindow(20, "1 m")` or `fixedWindow(...)`.
- `redis` — the Upstash Redis client backing the limiter; defaults to `Redis.fromEnv()`.
- `prefix` — base key prefix; keys are `<prefix>:<identifier>` (default `agentkit:rateLimit`).

There is no model wrapper; pass a per-user `identifier` to `.limit()` to throttle per user.

</details>

## Tool cache

Memoize deterministic tool results in Redis, keyed by user, then tool, then a hash of the arguments.

```ts
// `wrap` returns a memoized version of your execute, keyed by userId + "getWeather" + the args hash.
const getWeather = cache.wrap("user-123", "getWeather", (args) => fetchWeather(args));
```

<details>
<summary>Config, the low-level API &amp; the key parts</summary>

```ts
new ToolCache({
  redis,
  prefix: "agentkit:toolCache", // optional: base key prefix
  ttlSeconds: 600, // optional: default TTL (default: no expiry)
});
```

`wrap(userId, toolName, execute, { ttlSeconds? })` is the high-level helper; `get` / `set` /
`invalidate` are the low-level API. Keys are `agentkit:toolCache:<userId>:<toolName>:<hash>`.

`userId` and `toolName` are both **required, non-empty, and may not contain `:`** (all methods throw
otherwise). The entry is scoped to the user first, so one user's cached result is never served to
another — provided `userId` comes from a verified auth source, not a client-supplied value.

</details>

## Advanced — the raw search index

The search-backed features expose their Redis Search index handle (`describe`, `count`, `waitIndexing`,
`drop`):

```ts
await memory.searchIndex.waitIndexing();
const info = await memory.searchIndex.describe();
```

## Testing

Tested against a **real Upstash Redis** instance (no Redis mock); only LLM calls are mocked. Set
`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (suites skip when absent). Each suite uses a
unique key prefix and cleans up afterwards.

## License

MIT
