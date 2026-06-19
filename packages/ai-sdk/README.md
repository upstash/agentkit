# @upstash/agentkit-ai-sdk

[Vercel AI SDK](https://ai-sdk.dev) adapter for [Upstash AgentKit](https://www.npmjs.com/package/@upstash/agentkit-sdk).
Everything is a drop-in for `generateText` / `streamText`: a semantic-caching model wrapper, a
tool-cache for tool maps, and ready-made memory + Redis-Search tools.

```bash
pnpm add @upstash/agentkit-ai-sdk @upstash/agentkit-sdk @upstash/redis ai
```

## Semantic model cache

`semanticCachedModel` wraps any AI SDK model with an
[language-model middleware](https://ai-sdk.dev/docs/ai-sdk-core/middleware#caching) that serves a
cached response when a new prompt fuzzily matches a previous one (Upstash Redis Search `$smart`).

```ts
import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import { semanticCachedModel } from "@upstash/agentkit-ai-sdk";

const model = semanticCachedModel({ model: openai("gpt-4o"), redis });

await generateText({ model, prompt: "What is the capital of France?" }); // model call
await generateText({ model, prompt: "the capital of France?" }); // fuzzy cache hit
```

Or use the middleware directly with `wrapLanguageModel`:

```ts
import { wrapLanguageModel } from "ai";
import { semanticCacheMiddleware } from "@upstash/agentkit-ai-sdk";

const model = wrapLanguageModel({ model: base, middleware: semanticCacheMiddleware({ redis }) });
```

## Rate limiting

`rateLimitedModel` wraps a model so each call is rate-limited with
[Upstash Ratelimit](https://github.com/upstash/ratelimit-js) — throwing (or waiting) when the limit
is exceeded. Build the model per request with a per-user `identifier` to limit by user.

```ts
import { rateLimitedModel } from "@upstash/agentkit-ai-sdk";

const model = rateLimitedModel({ model: openai("gpt-4o"), redis, limit: 20, window: "1 m", identifier: userId });
await generateText({ model, prompt }); // throws RateLimitExceededError once over the limit
```

Compose it with the cache: `rateLimitedModel({ model: semanticCachedModel({ model, redis }), redis })`.

## Tool-call cache

`cacheTools` takes a map of tools and returns a map with the **same keys** whose `execute` is
memoized (keyed by tool name + arguments).

```ts
import { cacheTools } from "@upstash/agentkit-ai-sdk";
import { ToolCache } from "@upstash/agentkit-sdk";

const tools = cacheTools({ getWeather, search }, { toolCache: new ToolCache({ redis }) });
await generateText({ model, tools, prompt });
```

## Memory tools

`createMemoryTools` returns `recall_memory` and `save_memory` tools so the model can read and write
long-term memory itself. Spread them into your tool map.

```ts
import { AgentMemory } from "@upstash/agentkit-sdk";
import { createMemoryTools } from "@upstash/agentkit-ai-sdk";
import { generateText, stepCountIs } from "ai";

const tools = createMemoryTools({ memory: new AgentMemory({ redis }), scope: userId });
await generateText({ model, tools, stopWhen: stepCountIs(5), prompt });
```

## Search tools

`createSearchTools` returns `search` / `aggregate` / `count` tools over an Upstash Redis Search
index. Pass your `s.object(...)` schema and the tool descriptions are generated from it — the model
learns the fields, types, and which filter operators (`$smart`, `$lt`, `$in`, `$and`, …) apply.

```ts
import { s } from "@upstash/redis";
import { createSearchTools } from "@upstash/agentkit-ai-sdk";
import { generateText, stepCountIs } from "ai";

const schema = s.object({ name: s.string(), age: s.number(), city: s.string().noTokenize() });

await generateText({
  model,
  tools: createSearchTools({ schema, name: "users" }),
  stopWhen: stepCountIs(5),
  prompt: "How many users named Ada live in London?",
});
```

`redis` defaults to `Redis.fromEnv()` everywhere; the index is created from the schema on first use.

## Testing

Tests run against a **real Upstash Redis** (only LLM calls are mocked). Set
`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (suites skip when absent).

## License

MIT
