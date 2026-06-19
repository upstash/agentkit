# @upstash/agentkit-ai-sdk

Vercel AI SDK adapter for [Upstash AgentKit](https://www.npmjs.com/package/@upstash/agentkit-sdk).

It bridges the core AgentKit primitives (chat history, semantic cache, sandbox, tool cache, long-term
memory, telemetry) to the [Vercel AI SDK](https://sdk.vercel.dev) (the `ai` package, v5+ including the
v7 tool harness concepts).

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
import { SemanticCache, upstashSearchStore } from "@upstash/agentkit-sdk";
import { withSemanticCache } from "@upstash/agentkit-ai-sdk";
import { generateText } from "ai";

const search = upstashSearchStore(redis.search.index({ name: "agentkit", schema }));

const cachedGenerate = withSemanticCache(
  (args) => generateText({ model, prompt: args.prompt }),
  { cache: new SemanticCache({ search }) },
);

const { text } = await cachedGenerate({ prompt: "What is the capital of France?" });
// A paraphrase hits the cache and skips the model call.
```

There is also `withSemanticCacheText` for `(prompt: string) => Promise<string>` call sites.

### Tool wrapping (sandbox + tool cache)

Run AI SDK tools through AgentKit's `Sandbox` (timeout, bounded retries, abort propagation) and/or
`ToolCache` (memoized deterministic results). The returned object keeps the AI SDK tool shape.

```ts
import { Sandbox, ToolCache } from "@upstash/agentkit-sdk";
import { wrapTool, sandboxedTool } from "@upstash/agentkit-ai-sdk";
import { tool, generateText } from "ai";
import { z } from "zod";

const search = tool({
  description: "Search the web",
  inputSchema: z.object({ query: z.string() }),
  execute: async ({ query }, { abortSignal }) => doSearch(query, abortSignal),
});

const sandbox = new Sandbox({ timeoutMs: 5000, maxRetries: 2 });
const toolCache = new ToolCache({ redis });

await generateText({
  model,
  prompt: input,
  tools: {
    // timeout/retry/abort:
    search: sandboxedTool("search", search, sandbox),
    // or both sandbox + cache:
    // search: wrapTool("search", search, { sandbox, toolCache }),
  },
});
```

A sandbox timeout surfaces as a thrown `ToolTimeoutError`, which the AI SDK tool harness handles as a
tool error.

### Memory injection

Recall relevant long-term memories for a user input and prepend them as a system message.

```ts
import { AgentMemory, upstashSearchStore } from "@upstash/agentkit-sdk";
import { withMemory } from "@upstash/agentkit-ai-sdk";
import { generateText } from "ai";

const search = upstashSearchStore(redis.search.index({ name: "agentkit", schema }));
const injector = withMemory({ memory: new AgentMemory({ search }), scope: userId });

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

## License

MIT
