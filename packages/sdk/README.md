# @upstash/agentkit-sdk

Core, framework-agnostic primitives for building AI agents on [Upstash Redis](https://upstash.com/)
and [Upstash Vector](https://upstash.com/vector).

```bash
pnpm add @upstash/agentkit-sdk @upstash/redis @upstash/vector
```

## Wiring up

```ts
import { Redis } from "@upstash/redis";
import { Index } from "@upstash/vector";
import {
  AgentMemory,
  ChatHistory,
  SemanticCache,
  ToolCache,
  Telemetry,
  Sandbox,
  Rag,
  upstashVectorStore,
} from "@upstash/agentkit-sdk";

const redis = Redis.fromEnv();
const vector = upstashVectorStore(new Index());
```

## Features

### Agent memory

```ts
const memory = new AgentMemory({ vector, redis });
await memory.add("The user prefers TypeScript", { scope: "user-123" });
const hits = await memory.recall("language preference", { scope: "user-123" });
```

### Chat history

```ts
const history = new ChatHistory({ redis, maxMessages: 50, ttlSeconds: 3600 });
await history.append("session-1", { role: "user", content: "Hello" });
const messages = await history.list("session-1");
```

### Semantic cache

```ts
const cache = new SemanticCache({ vector, minScore: 0.92 });
const generate = cache.wrap((prompt) => callYourLLM(prompt));
await generate("What is the capital of France?"); // model call
await generate("France's capital?"); // cache hit
```

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
const rag = new Rag({ vector });
await rag.ingest({ id: "doc-1", text: longDocument });
const chunks = await rag.retrieve("how does vector search work?", { topK: 4 });
```

## Testing

Import deterministic, offline test doubles from the `/testing` entry point — no network, no real LLM:

```ts
import { MemoryRedis, MemoryVectorStore, MockEmbedder, MockModel } from "@upstash/agentkit-sdk/testing";
```

## License

MIT
