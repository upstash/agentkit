# @upstash/agentkit-sdk

Core, framework-agnostic primitives for building AI agents — entirely on
[Upstash Redis](https://upstash.com/). No vector database required: the "semantic" features (memory
recall, search) are powered by [Upstash Redis Search](https://upstash.com/docs/redis/search/introduction)
and its `$smart` fuzzy operator (layered phrase / term / fuzzy / prefix matching, BM25-scored).

```bash
pnpm add @upstash/agentkit-sdk @upstash/redis
```

## Wiring up

Every feature takes the `@upstash/redis` client and nothing else — the search-backed features create
and own their Redis Search index internally:

```ts
import { Redis } from "@upstash/redis";
import { AgentMemory, ChatHistory, ToolCache } from "@upstash/agentkit-sdk";

const redis = Redis.fromEnv();

const history = new ChatHistory({ redis });
const memory = new AgentMemory({ redis });
const tools = new ToolCache({ redis });
```

The raw search index handle is exposed for advanced use (`describe`, `count`, `waitIndexing`, `drop`):

```ts
await memory.searchIndex.waitIndexing();
const info = await memory.searchIndex.describe();
```

## Features

### Chat history

Durable conversation transcripts backed by Upstash Redis Search — the source of truth for a chat.
`ChatHistory<TMessage>` is generic over the message type (the ai-sdk adapter specializes it to
`UIMessage`, eve to `EveMessage`). Each chat is one JSON doc at `agentkit:chat:<userId>:<sessionId>`
(keyed per user, so two users can't collide on a `sessionId`), indexed
over `userId` + `sessionId` (exact-match filters) and `userMessages` + `modelMessages` (`$smart`
fuzzy text); the raw `messages` array and `metadata` ride along **unindexed**. So you can filter by
`userId` to list a user's chats and `$smart`-search within what the user or the model said.

```ts
const history = new ChatHistory<MyMessage>({
  redis, // the Upstash Redis client (the search index is created/managed internally)
  prefix: "agentkit:chat", // optional: base key prefix (defaults to "agentkit:chat")
  indexName: "agentkit_chat", // optional: Redis Search index name (defaults to the prefix)
  ttlSeconds: 60 * 60 * 24 * 30, // optional: per-chat TTL in seconds (default: no expiry)
  extractText: (messages) => ({ userMessages: "...", modelMessages: "..." }), // optional: override how text is pulled into the two indexed fields (defaults to the UIMessage/EveMessage convention)
});

// Every method takes a single object. `userId` is **required** and must be **unique per user** — it's
// the tenant boundary: chats are keyed per user, so one user can never read or overwrite another's.
// `saveChat` REPLACES the whole message array (overwrite, not append) — pass the complete transcript,
// typically server-side once a turn finishes (e.g. the AI SDK route's `onFinish`).
await history.saveChat({
  userId: "user-123", // required, non-empty, unique per user (the owner of the chat)
  sessionId: "session-abc", // required, non-empty (the chat/session id)
  messages, // the full transcript
  title: "Trip planning", // optional: human-readable title
  metadata: { session: cursor }, // optional: arbitrary unindexed data (e.g. an eve session cursor)
});

const chat = await history.getChat({ userId: "user-123", sessionId: "session-abc" }); // full transcript, or null
const chats = await history.listChats({
  userId: "user-123", // required
  limit: 50, // optional: max chats to return (newest-updated first)
});

const hits = await history.searchChats({
  userId: "user-123", // required
  query: "wireless headphones",
  target: "both", // optional: which side to match — "user" | "model" | "both" (defaults to "both")
  limit: 20, // optional: max hits to return
  minScore: 0, // optional: BM25 relevance floor (defaults to 0)
});

await history.deleteChat({ userId: "user-123", sessionId: "session-abc" }); // delete (also de-indexes it)
```

> **`userId` and `sessionId` are required and must be non-empty** — they are the only tenant
> boundary, so an empty value throws rather than silently mis-scoping a chat. Make `userId` unique
> per user (e.g. your auth subject id); a chat can't be read or overwritten by a different `userId`.

### Agent memory

Long-term, fuzzily-recalled memory scoped per user. Stored at `agentkit:memory:<userId>:<id>`.

```ts
const memory = new AgentMemory({
  redis, // the Upstash Redis client (the search index is created/managed internally)
  prefix: "agentkit:memory", // optional: base key prefix (defaults to "agentkit:memory")
  indexName: "agentkit_memory", // optional: Redis Search index name (defaults to the prefix)
  minScore: 0, // optional: default BM25 relevance floor for recall
});

await memory.add("The user prefers TypeScript", {
  userId: "user-123", // required, non-empty: the user the memory belongs to
  id: "pref-lang", // optional: stable id (generated when omitted)
  metadata: { source: "chat" }, // optional: extra data stored with the memory
});

const hits = await memory.recall("typescript preference", {
  userId: "user-123", // required, non-empty: the user to recall for
  topK: 5, // optional: max memories to return (defaults to 5)
  minScore: 0, // optional: BM25 relevance floor (defaults to the constructor's minScore)
});

await memory.forget("pref-lang", { userId: "user-123" }); // required, non-empty userId
```

> **`userId` is required and must be non-empty** on every method — it's the only tenant boundary
> for memory, so an empty value throws rather than collapsing all callers into one shared bucket.
> Make it **unique per user** (e.g. the user id) to keep each user's memories isolated.

### Search tools

Framework-agnostic `search` / `aggregate` / `count` tool **definitions** over an Upstash Redis Search
index. `createSearchToolDefs` returns `{ description, inputSchema, execute }` triples — the ai-sdk
adapter wraps them with `tool()`, the eve adapter with `defineTool()`. The descriptions are generated
from your `s.object(...)` schema (fields, types, applicable filter operators). The index is created
**reactively** on first use (no setup step).

```ts
import { s } from "@upstash/redis";
import { createSearchToolDefs } from "@upstash/agentkit-sdk";

const defs = createSearchToolDefs({
  schema: s.object({ name: s.string(), age: s.number(), city: s.string().noTokenize() }), // the Upstash Redis Search schema (built with `s`)
  redis, // the Upstash Redis client
  indexName: "users", // optional: index name (defaults to "agentkit:search")
  prefix: "users:", // optional: key prefix for indexed JSON docs (defaults to "<name>:")
  defaultLimit: 10, // optional: default page size for the `search` tool (defaults to 10)
});

// defs.search / defs.aggregate / defs.count — each `{ description, inputSchema, execute }`.
```

> **RAG?** There's no dedicated RAG primitive — use the **search tools** above over your own
> documents. Index your docs as JSON under one prefix with a schema you control, then give the agent
> the generated `search`/`aggregate`/`count` tools (typo-tolerant `$smart` retrieval, BM25-ranked).

### Rate limiting

`createRateLimit` returns a configured [Upstash Ratelimit](https://github.com/upstash/ratelimit-js)
`Ratelimit` with AgentKit defaults. There's no model wrapper — call `.limit(identifier)` yourself
before doing work (e.g. before calling a model) and short-circuit when over the limit. Keys are
`agentkit:rateLimit:<identifier>`.

```ts
import { createRateLimit, Ratelimit } from "@upstash/agentkit-sdk";

const ratelimit = createRateLimit({
  redis, // the Upstash Redis client backing the limiter
  limiter: Ratelimit.slidingWindow(20, "1 m"), // required: the limiter algorithm (or fixedWindow, …)
  prefix: "agentkit:rateLimit", // optional: base key prefix; keys are `<prefix>:<identifier>`
});

const { success } = await ratelimit.limit("user-123"); // pass a per-user identifier to limit by user
if (!success) throw new Error("rate limited");
```

### Tool cache

Memoize deterministic tool results in Redis, keyed by user, then tool, then a stable hash of the
arguments. Keys are `agentkit:toolCache:<userId>:<toolName>:<hash>`.

```ts
const tools = new ToolCache({
  redis, // the Upstash Redis client
  prefix: "agentkit:toolCache", // optional: base key prefix (defaults to "agentkit:toolCache")
  ttlSeconds: 600, // optional: default TTL in seconds for cached results (default: no expiry)
});

// `wrap` returns a memoized version of your execute, keyed by userId + "getWeather" + the args hash.
const getWeather = tools.wrap(
  "user-123", // required, non-empty: the user the cache entry is scoped to
  "getWeather", // required, non-empty: the tool name
  (args) => fetchWeather(args), // the function to memoize
  { ttlSeconds: 600 }, // optional: per-result TTL (overrides the constructor default)
);
```

> **`userId` and `toolName` are both required and must be non-empty** (`get`/`set`/`invalidate`/`wrap`
> all throw on an empty value). The entry is scoped to the user first, so one user's cached result is
> never served to another.

## Testing

The SDK is tested against a **real Upstash Redis** instance (no Redis mock) — only LLM calls are
mocked. Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (the suites skip themselves when
these are absent). Each suite uses a unique key prefix and cleans up its index/keys afterwards.

## License

MIT
