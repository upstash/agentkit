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
import { AgentMemory, Rag, ToolCache } from "@upstash/agentkit-sdk";

const redis = Redis.fromEnv();

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
