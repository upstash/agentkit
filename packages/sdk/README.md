# @upstash/agentkit-sdk

Core, framework-agnostic primitives for building AI agents — entirely on
[Upstash Redis](https://upstash.com/). No vector database required: the "semantic" features (memory
recall, semantic cache, RAG) are powered by [Upstash Redis Search](https://upstash.com/docs/redis/search/introduction)
and its `$smart` fuzzy operator (layered phrase / term / fuzzy / prefix matching, BM25-scored).

```bash
pnpm add @upstash/agentkit-sdk @upstash/redis
```

## Wiring up

Every feature takes the `@upstash/redis` client and nothing else — the search-backed features create
and own their Redis Search index internally:

```ts
import { Redis } from "@upstash/redis";
import { AgentMemory, ChatHistory, SemanticCache, ToolCache, Telemetry, Rag } from "@upstash/agentkit-sdk";

const redis = Redis.fromEnv();

const memory = new AgentMemory({ redis });
const history = new ChatHistory({ redis });
const cache = new SemanticCache({ redis });
const tools = new ToolCache({ redis });
const telemetry = new Telemetry({ redis });
const rag = new Rag({ redis });
```

The raw search index handle is exposed for advanced use (`describe`, `count`, `waitIndexing`, `drop`):

```ts
await memory.searchIndex.waitIndexing();
const info = await rag.searchIndex.describe();
```

## Features

### Agent memory

```ts
const memory = new AgentMemory({ redis });
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
const cache = new SemanticCache({ redis, minScore: 1 });
const generate = cache.wrap((prompt) => callYourLLM(prompt));
await generate("What is the capital of France?"); // model call
await generate("capital of France?"); // fuzzy cache hit — no model call
```

> Matching is fuzzy text (`$smart`), not embedding similarity — it catches typos and shared wording.
> Scores are BM25 (unbounded), so tune `minScore` to your prompts.

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

### RAG

```ts
const rag = new Rag({ redis });
await rag.ingest({ id: "doc-1", text: longDocument });
const chunks = await rag.retrieve("how does redis search work?", { topK: 4 });
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
