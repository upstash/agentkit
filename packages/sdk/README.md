# @upstash/agentkit-sdk

Core, framework-agnostic primitives for building AI agents — entirely on
[Upstash Redis](https://upstash.com/). No vector database required: the "semantic" features (memory
recall, semantic cache, RAG) are powered by [Upstash Redis Search](https://upstash.com/docs/redis/search/introduction)
and its `$smart` fuzzy operator (layered phrase / term / fuzzy / prefix matching, BM25-scored).

```bash
pnpm add @upstash/agentkit-sdk @upstash/redis
```

## Wiring up

Create a search index once (it backs memory, the semantic cache, and RAG), then build a
`SearchStore` from it:

```ts
import { Redis, s } from "@upstash/redis";
import {
  AgentMemory,
  ChatHistory,
  SemanticCache,
  ToolCache,
  Telemetry,
  Sandbox,
  Rag,
  upstashSearchStore,
} from "@upstash/agentkit-sdk";

const redis = Redis.fromEnv();

await redis.search.createIndex({
  name: "agentkit",
  dataType: "json",
  prefix: "agentkit:",
  schema: s.object({
    text: s.string(),
    scope: s.string().noTokenize(),
    docId: s.string().noTokenize(),
  }),
});

const search = upstashSearchStore(redis.search.index({ name: "agentkit" }));
```

Everything else takes `redis` and/or `search`.

## Features

### Agent memory

```ts
const memory = new AgentMemory({ search, redis });
await memory.add("The user prefers TypeScript", { scope: "user-123" });
const hits = await memory.recall("typescript preference", { scope: "user-123" });
```

### Chat history

```ts
const history = new ChatHistory({ redis, maxMessages: 50, ttlSeconds: 3600 });
await history.append("session-1", { role: "user", content: "Hello" });
const messages = await history.list("session-1");
```

### Semantic cache

```ts
const cache = new SemanticCache({ search, minScore: 0.85 });
const generate = cache.wrap((prompt) => callYourLLM(prompt));
await generate("What is the capital of France?"); // model call
await generate("capital of France?"); // fuzzy cache hit — no model call
```

> Fuzzy text matching catches typos and shared wording, not deep paraphrases with disjoint
> vocabulary. Tune `minScore` to your data.

### Tool-call cache

```ts
const tools = new ToolCache({ redis, ttlSeconds: 600 });
const getWeather = tools.wrap("getWeather", (args) => fetchWeather(args));
```

### Telemetry

```ts
const telemetry = new Telemetry({ redis });
await telemetry.trace("agent-run", async (span) => {
  span.setAttribute("model", "claude-opus-4-8");
  // ... do work
}, { type: "run" });
```

### Sandbox (tool harness)

```ts
const sandbox = new Sandbox({ timeoutMs: 10_000, maxRetries: 2, telemetry, toolCache: tools });
sandbox.register({ name: "search", execute: async (args, ctx) => doSearch(args, ctx.signal) });
const result = await sandbox.run("search", { query: "redis" });
```

### RAG

```ts
const rag = new Rag({ search });
await rag.ingest({ id: "doc-1", text: longDocument });
const chunks = await rag.retrieve("how does redis search work?", { topK: 4 });
```

## Testing

Import deterministic, offline test doubles from the `/testing` entry point — no network, no real LLM,
no real index. `MemorySearchStore` approximates `$smart` (term + fuzzy + prefix matching with a
phrase boost) and scores hits in `[0, 1]`:

```ts
import { MemoryRedis, MemorySearchStore, MockModel } from "@upstash/agentkit-sdk/testing";

const search = new MemorySearchStore();
const redis = new MemoryRedis();
```

## License

MIT
