# @upstash/agentkit-sdk

Core, framework-agnostic primitives for building AI agents — entirely on
[Upstash Redis](https://upstash.com/). No vector database required: the "semantic" features (memory
recall, RAG) are powered by [Upstash Redis Search](https://upstash.com/docs/redis/search/introduction)
and its `$smart` fuzzy operator (layered phrase / term / fuzzy / prefix matching, BM25-scored).

```bash
pnpm add @upstash/agentkit-sdk @upstash/redis
```

## Wiring up

Every feature takes the `@upstash/redis` client and nothing else — the search-backed features create
and own their Redis Search index internally:

```ts
import { Redis } from "@upstash/redis";
import { AgentMemory, ChatHistory, Rag, ToolCache } from "@upstash/agentkit-sdk";

const redis = Redis.fromEnv();

const history = new ChatHistory({ redis });
const memory = new AgentMemory({ redis });
const rag = new Rag({ redis });
const tools = new ToolCache({ redis });
```

The raw search index handle is exposed for advanced use (`describe`, `count`, `waitIndexing`, `drop`):

```ts
await memory.searchIndex.waitIndexing();
const info = await rag.searchIndex.describe();
```

## Features

### Chat history

Durable conversation transcripts backed by Upstash Redis Search — the source of truth for a chat.
`ChatHistory<TMessage>` is generic over the message type (the ai-sdk adapter specializes it to
`UIMessage`, eve to `EveMessage`). Each chat is one JSON doc at `agentkit:chat:<sessionId>`, indexed
over `userId` + `sessionId` (exact-match filters) and `userMessages` + `modelMessages` (`$smart`
fuzzy text); the raw `messages` array and `metadata` ride along **unindexed**. So you can filter by
`userId` to list a user's chats and `$smart`-search within what the user or the model said.

```ts
const history = new ChatHistory<MyMessage>({
  redis, // the Upstash Redis client (the search index is created/managed internally)
  namespace: "agentkit:chat", // optional: key prefix + index name base (defaults to "agentkit:chat")
  ttlSeconds: 60 * 60 * 24 * 30, // optional: per-chat TTL in seconds (default: no expiry)
  extractText: (messages) => ({ userMessages: "...", modelMessages: "..." }), // optional: override how text is pulled into the two indexed fields (defaults to the UIMessage/EveMessage convention)
});

// Overwrite the WHOLE message array — the frontend sends the full conversation, so there's no delta to merge.
await history.saveChat("user-123", "session-abc", messages, {
  title: "Trip planning", // optional: human-readable title
  metadata: { session: cursor }, // optional: arbitrary unindexed data (e.g. an eve session cursor)
});

const chat = await history.getChat("user-123", "session-abc"); // full transcript, or null
const chats = await history.listChats("user-123", {
  limit: 50, // optional: max chats to return (newest-updated first)
});

const hits = await history.searchChats("user-123", "wireless headphones", {
  target: "both", // optional: which side to match — "user" | "model" | "both" (defaults to "both")
  limit: 20, // optional: max hits to return
  minScore: 0, // optional: BM25 relevance floor (defaults to 0)
});

const created = await history.createChat("user-123", {
  sessionId: "session-xyz", // optional: stable id (generated when omitted)
  title: "New chat", // optional: human-readable title
  messages: [], // optional: pre-seed the transcript
  metadata: { source: "web" }, // optional: arbitrary unindexed data
});

await history.setTitle("user-123", "session-abc", "Trip planning"); // set/replace the title
await history.deleteChat("user-123", "session-abc"); // delete a chat (also de-indexes it)
```

### Agent memory

Long-term, fuzzily-recalled memory scoped per agent/user. Stored at `agentkit:memory:<namespace>:<id>`.

```ts
const memory = new AgentMemory({
  redis, // the Upstash Redis client (the search index is created/managed internally)
  namespace: "agentkit:memory", // optional: key prefix + index name base (defaults to "agentkit:memory")
  minScore: 0, // optional: default BM25 relevance floor for recall
});

await memory.add("The user prefers TypeScript", {
  namespace: "user-123", // optional: the memory scope (defaults to "default")
  id: "pref-lang", // optional: stable id (generated when omitted)
  metadata: { source: "chat" }, // optional: extra data stored with the memory
});

const hits = await memory.recall("typescript preference", {
  namespace: "user-123", // optional: the memory scope to search (defaults to "default")
  topK: 5, // optional: max memories to return (defaults to 5)
  minScore: 0, // optional: BM25 relevance floor (defaults to the constructor's minScore)
});

await memory.forget("pref-lang", { namespace: "user-123" }); // optional namespace (defaults to "default")
```

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
  name: "users", // optional: index name (defaults to "agentkit:search")
  prefix: "users:", // optional: key prefix for indexed JSON docs (defaults to "<name>:")
  defaultLimit: 10, // optional: default page size for the `search` tool (defaults to 10)
});

// defs.search / defs.aggregate / defs.count — each `{ description, inputSchema, execute }`.
```

### RAG

Chunk documents, index the chunks, then fuzzily retrieve the most relevant ones. Stored at
`agentkit:rag:<docId>:<chunk>`.

```ts
const rag = new Rag({
  redis, // the Upstash Redis client (the search index is created/managed internally)
  namespace: "agentkit:rag", // optional: key prefix + index name base (defaults to "agentkit:rag")
  chunkSize: 1000, // optional: target chunk size in characters (defaults to 1000)
  chunkOverlap: 200, // optional: overlap between consecutive chunks in characters (defaults to 200)
});

await rag.ingest(
  { id: "doc-1", text: longDocument, metadata: { source: "docs" } }, // `id`/`metadata` optional
  { chunkSize: 1000, chunkOverlap: 200 }, // optional: per-call overrides of the constructor's chunking
);

const chunks = await rag.retrieve("how does redis search work?", {
  topK: 4, // optional: max chunks to return (defaults to 5)
  minScore: 0, // optional: BM25 relevance floor (defaults to 0)
  docId: "doc-1", // optional: restrict retrieval to a single document
});

await rag.remove("doc-1", { chunkCount: chunks.length }); // remove a document's chunks
```

### Rate limiting

`createRateLimit` returns a configured [Upstash Ratelimit](https://github.com/upstash/ratelimit-js)
`Ratelimit` with AgentKit defaults. There's no model wrapper — call `.limit(identifier)` yourself
before doing work (e.g. before calling a model) and short-circuit when over the limit. Keys are
`agentkit:rateLimit:<identifier>`.

```ts
import { createRateLimit, Ratelimit } from "@upstash/agentkit-sdk";

const ratelimit = createRateLimit({
  redis, // the Upstash Redis client backing the limiter
  limit: 20, // optional: requests allowed per window (default: 10)
  window: "1 m", // optional: sliding-window duration, e.g. "10 s" / "1 m" (default: "60 s")
  namespace: "agentkit:rateLimit", // optional: key prefix string; keys are `<namespace>:<identifier>`
  limiter: Ratelimit.fixedWindow(20, "1 m"), // optional: a custom limiter overriding limit/window
});

const { success } = await ratelimit.limit("user-123"); // pass a per-user identifier to limit by user
if (!success) throw new Error("rate limited");
```

### Tool cache

Memoize deterministic tool results in Redis, keyed by namespace + a stable hash of the arguments.
Keys are `agentkit:toolCache:<namespace>:<hash>`.

```ts
const tools = new ToolCache({
  redis, // the Upstash Redis client
  namespace: "agentkit:toolCache", // optional: base key prefix (defaults to "agentkit:toolCache")
  ttlSeconds: 600, // optional: default TTL in seconds for cached results (default: no expiry)
});

// `wrap` returns a memoized version of your execute, keyed by "getWeather" + the args hash.
const getWeather = tools.wrap(
  "getWeather", // the per-call cache namespace (e.g. the tool name)
  (args) => fetchWeather(args), // the function to memoize
  { ttlSeconds: 600 }, // optional: per-result TTL (overrides the constructor default)
);
```

## Testing

The SDK is tested against a **real Upstash Redis** instance (no Redis mock) — only LLM calls are
mocked, via `MockModel`:

```ts
import { MockModel } from "@upstash/agentkit-sdk/testing";
```

Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (the suites skip themselves when these
are absent). Each suite uses a unique namespace and cleans up its index/keys afterwards.

## License

MIT
