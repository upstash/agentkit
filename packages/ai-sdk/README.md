# @upstash/agentkit-ai-sdk

[Vercel AI SDK](https://ai-sdk.dev) adapter for [Upstash AgentKit](https://www.npmjs.com/package/@upstash/agentkit-sdk).
Everything is a drop-in for `generateText` / `streamText`: model wrappers (response cache + rate
limit), a self-contained cached tool, and ready-made memory + Redis-Search tools. `redis` defaults to
`Redis.fromEnv()` everywhere, so you import only from this package.

```bash
pnpm add @upstash/agentkit-ai-sdk @upstash/redis ai
```

## Model cache

`cachedModel` wraps any AI SDK model with a
[language-model middleware](https://ai-sdk.dev/docs/ai-sdk-core/middleware#caching) that serves a
cached response when a new prompt fuzzily matches a previous one (Upstash Redis Search `$smart`).

```ts
import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import { cachedModel } from "@upstash/agentkit-ai-sdk";

const model = cachedModel({ model: openai("gpt-4o"), redis });

await generateText({ model, prompt: "What is the capital of France?" }); // model call
await generateText({ model, prompt: "the capital of France?" }); // fuzzy cache hit
```

Or use the middleware directly with `wrapLanguageModel`:

```ts
import { wrapLanguageModel } from "ai";
import { modelCacheMiddleware } from "@upstash/agentkit-ai-sdk";

const model = wrapLanguageModel({ model: base, middleware: modelCacheMiddleware({ redis }) });
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

Use both at once by nesting the wrappers, or apply both middlewares in one `wrapLanguageModel`:

```ts
// nest the wrappers
const model = rateLimitedModel({ model: cachedModel({ model: openai("gpt-4o"), redis }), redis });

// or one wrapLanguageModel with multiple middlewares (applied in array order)
import { wrapLanguageModel } from "ai";
import { modelCacheMiddleware, rateLimitMiddleware } from "@upstash/agentkit-ai-sdk";

const model = wrapLanguageModel({
  model: openai("gpt-4o"),
  middleware: [rateLimitMiddleware({ redis }), modelCacheMiddleware({ redis })],
});
```

## Cached tool

`cachedTool` is like the AI SDK's `tool()`, but its `execute` is memoized in Redis — self-contained,
no core import.

```ts
import { z } from "zod";
import { cachedTool } from "@upstash/agentkit-ai-sdk";

const getWeather = cachedTool({
  description: "Get the weather for a city",
  inputSchema: z.object({ city: z.string() }),
  cachePrefix: "getWeather", // or (input, options) => `weather:${input.city}`
  execute: async ({ city }) => fetchWeather(city),
});
await generateText({ model, tools: { getWeather }, prompt });
```

## Memory tools

`createMemoryTools` returns `recall_memory` and `save_memory` tools so the model can read and write
long-term memory itself. Pass a `scope` (a string shared across users, or a function deriving it per
call); `redis` defaults to env.

```ts
import { createMemoryTools } from "@upstash/agentkit-ai-sdk";
import { generateText, stepCountIs } from "ai";

const tools = createMemoryTools({ scope: userId });
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
