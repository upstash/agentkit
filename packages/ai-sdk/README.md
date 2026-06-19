# @upstash/agentkit-ai-sdk

Vercel AI SDK adapter for [Upstash AgentKit](https://www.npmjs.com/package/@upstash/agentkit-sdk).

It bridges the core AgentKit primitives (chat history, semantic cache, tool cache, long-term memory,
telemetry) to the [Vercel AI SDK](https://sdk.vercel.dev) (the `ai` package, v5+ including the v7 tool
harness concepts).

The adapter **never imports the `ai` package** — it codes against minimal structural interfaces, so it
compiles and tests fully offline. The `ai` package is an optional peer dependency you bring in your app.

## Install

```bash
npm install @upstash/agentkit-ai-sdk @upstash/agentkit-sdk
# plus the AI SDK and a provider in your app:
npm install ai @ai-sdk/openai
```

## Helpers

### Message conversion

Convert between AgentKit `ChatMessage[]` and AI-SDK-style core messages (string content).

```ts
import { toCoreMessages, fromCoreMessages } from "@upstash/agentkit-ai-sdk";

const core = toCoreMessages([{ role: "user", content: "Hello" }]);
const back = fromCoreMessages(core); // -> ChatMessage[]
```

### Persistent chat history

Hydrate a model call from prior turns and persist the reply, using an AgentKit `ChatHistory`.

```ts
import { ChatHistory } from "@upstash/agentkit-sdk";
import { createHistoryStore } from "@upstash/agentkit-ai-sdk";
import { generateText } from "ai";

const store = createHistoryStore({ history: new ChatHistory({ redis }) });

const prior = await store.load(sessionId);
const result = await generateText({
  model,
  messages: [...prior, { role: "user", content: input }],
});

await store.save(sessionId, [{ role: "user", content: input }]);
await store.saveResult(sessionId, result);
```

### Semantic-cached generation

Serve semantically similar prompts from an AgentKit `SemanticCache` instead of re-calling the model.

```ts
import { SemanticCache } from "@upstash/agentkit-sdk";
import { withSemanticCache } from "@upstash/agentkit-ai-sdk";
import { generateText } from "ai";

const cachedGenerate = withSemanticCache(
  (args) => generateText({ model, prompt: args.prompt }),
  { cache: new SemanticCache({ redis }) },
);

const { text } = await cachedGenerate({ prompt: "What is the capital of France?" });
// A paraphrase hits the cache and skips the model call.
```

There is also `withSemanticCacheText` for `(prompt: string) => Promise<string>` call sites.

### Tool wrapping (tool cache)

Run AI SDK tools through AgentKit's `ToolCache` so deterministic results are memoized in Redis, keyed
by the tool name plus a stable hash of its arguments. The returned object keeps the AI SDK tool shape.

```ts
import { ToolCache } from "@upstash/agentkit-sdk";
import { wrapTool } from "@upstash/agentkit-ai-sdk";
import { tool, generateText } from "ai";
import { z } from "zod";

const search = tool({
  description: "Search the web",
  inputSchema: z.object({ query: z.string() }),
  execute: async ({ query }, { abortSignal }) => doSearch(query, abortSignal),
});

const toolCache = new ToolCache({ redis });

await generateText({
  model,
  prompt: input,
  tools: {
    // identical args are served from cache; the underlying execute runs at most once per arg set:
    search: wrapTool("search", search, { toolCache }),
  },
});
```

Without a `toolCache`, `wrapTool` simply calls the original `execute` directly.

### Memory injection

Recall relevant long-term memories for a user input and prepend them as a system message.

```ts
import { AgentMemory } from "@upstash/agentkit-sdk";
import { withMemory } from "@upstash/agentkit-ai-sdk";
import { generateText } from "ai";

const injector = withMemory({ memory: new AgentMemory({ redis }), scope: userId });

const messages = await injector.inject(input, [{ role: "user", content: input }]);
const result = await generateText({ model, messages });
```

### Telemetry

Wrap a generation in an AgentKit `Telemetry` `model` span recording model id and token usage.

```ts
import { Telemetry } from "@upstash/agentkit-sdk";
import { tracedGeneration } from "@upstash/agentkit-ai-sdk";
import { generateText } from "ai";

const telemetry = new Telemetry({ redis });

const result = await tracedGeneration(
  () => generateText({ model, prompt }),
  { telemetry, model: "gpt-4o", traceId },
);
```

## Testing

The adapter's tests run against a **real Upstash Redis** instance — only LLM calls are mocked
(via the core SDK's `MockModel`). Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`
(a repo-root `.env` is loaded automatically); when they are absent the Redis-backed suites skip
themselves. Search-backed features (`AgentMemory`, `SemanticCache`, `Rag`) own their index
internally, so tests `await feature.searchIndex.waitIndexing()` after writes before querying, and
clean up in `afterAll`/`afterEach`. Matching is fuzzy BM25 (`$smart`), so scores are unbounded —
tune `minScore` to your prompts rather than expecting a `[0, 1]` similarity.

## License

MIT
