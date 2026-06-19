# @upstash/agentkit-langchain

[LangChain.js](https://js.langchain.com/) adapter for
[`@upstash/agentkit-sdk`](https://www.npmjs.com/package/@upstash/agentkit-sdk). It wires the SDK's
Redis primitives — chat history, RAG retrieval, semantic LLM caching, tool caching/sandboxing,
and long-term memory — into LangChain's extension points, all backed by
[Upstash Redis](https://upstash.com/) and its built-in
[Redis Search](https://upstash.com/docs/redis/features/search) (the `$smart` fuzzy operator).

```bash
pnpm add @upstash/agentkit-langchain @upstash/agentkit-sdk @langchain/core
```

`@langchain/core` is an **optional** peer dependency. This package codes against minimal *structural*
interfaces that mirror LangChain's shapes (the same way the core SDK avoids importing `@upstash/redis`),
so it builds and tests without LangChain installed. The classes here are duck-type compatible with their
LangChain counterparts: a real `HumanMessage`, `Document`, or `BaseCache` satisfies the structural
types, and the objects produced here can be handed back to LangChain.

## Wiring up

```ts
import { Redis, s } from "@upstash/redis";
import { upstashSearchStore } from "@upstash/agentkit-sdk";

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

Retrieval, semantic caching, and memory all match with Upstash Redis Search's `$smart` fuzzy
operator (exact terms, typos, prefixes, and shared wording) — there are no embeddings or vector
index to manage.

## Chat message history

A `BaseChatMessageHistory`-style class bound to a session, backed by the SDK's `ChatHistory`.

```ts
import { RedisChatMessageHistory } from "@upstash/agentkit-langchain";

const history = new RedisChatMessageHistory({
  redis,
  sessionId: "user-42",
  maxMessages: 50,
  ttlSeconds: 3600,
});

await history.addUserMessage("Hello");
await history.addAIMessage("Hi there!");
const messages = await history.getMessages(); // LangChain-style messages with _getType()
```

Use it with `RunnableWithMessageHistory`:

```ts
import { RunnableWithMessageHistory } from "@langchain/core/runnables";

const chain = new RunnableWithMessageHistory({
  runnable: model,
  getMessageHistory: (sessionId) => new RedisChatMessageHistory({ redis, sessionId }),
  inputMessagesKey: "input",
  historyMessagesKey: "history",
});
```

## Retriever

A `BaseRetriever`-style class backed by the SDK's `Rag`. Exposes both `getRelevantDocuments(query)`
and the runnable `invoke(query)`, and an `addDocuments` for ingestion.

```ts
import { AgentKitRetriever } from "@upstash/agentkit-langchain";

const retriever = new AgentKitRetriever({ search, topK: 4 });
await retriever.addDocuments([{ pageContent: "Upstash is serverless.", metadata: { src: "docs" } }]);

const docs = await retriever.invoke("what is upstash?");
// docs: [{ pageContent, metadata: { src, docId, index, score } }, ...]
```

## Semantic LLM cache

A `BaseCache`-style class backed by the SDK's `SemanticCache`. Fuzzily-similar prompts (`$smart`
score ≥ `minScore`) reuse a cached generation, collapsing close paraphrases and typos onto a single
model call.

```ts
import { SemanticLLMCache } from "@upstash/agentkit-langchain";

const cache = new SemanticLLMCache({ search, minScore: 0.9 });
// Pass directly to a chat model:
const model = new ChatOpenAI({ cache });
```

## Tool caching & sandboxing

Wrap LangChain tools so calls memoize via `ToolCache` and/or run through the `Sandbox` (timeout,
retries, telemetry).

```ts
import { ToolCache, Sandbox } from "@upstash/agentkit-sdk";
import { cacheTool, sandboxTool } from "@upstash/agentkit-langchain";

const cached = cacheTool(searchTool, new ToolCache({ redis }), { ttlSeconds: 300 });
await cached.invoke({ query: "upstash" }); // runs once
await cached.invoke({ query: "upstash" }); // served from cache

const safe = sandboxTool(flakyTool, new Sandbox({ timeoutMs: 5000, maxRetries: 2 }));
await safe.invoke({ url: "https://example.com" });
```

## Long-term memory

Recall relevant facts and format them as prompt context, backed by the SDK's `AgentMemory`.

```ts
import { AgentKitMemory } from "@upstash/agentkit-langchain";

const memory = new AgentKitMemory({ search, redis, scope: "user-42" });
await memory.remember("The user prefers metric units.");

const context = await memory.asContext("what units should I use?");
// "Relevant memories:\n- The user prefers metric units."
```

## License

MIT
