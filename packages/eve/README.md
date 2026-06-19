# @upstash/agentkit-eve

Adapter that brings [Upstash AgentKit](https://upstash.com/) to **Eve, the Vercel agent framework**.
Eve is file-centric, so this package ships small pieces you drop into your `agent/` tree: cached
tools, long-term memory tools, model wrappers (response cache + rate limit), and a real
code-execution **sandbox backend** powered by [Upstash Box](https://github.com/upstash/box).

```bash
pnpm add @upstash/agentkit-eve @upstash/agentkit-sdk @upstash/redis
# in your app (Eve + the OpenAI provider, plus Box only if you use /sandbox):
pnpm add eve @ai-sdk/openai @upstash/box
```

A small shared Redis client is handy:

```ts
// agent/redis.ts
import { Redis } from "@upstash/redis";
export const redis = Redis.fromEnv();
```

## Model cache (`agent/index.ts`)

Wrap your agent's model with a response cache (re-exported from the AI SDK adapter — Eve uses Vercel
AI SDK models). See [agent config](https://eve.dev/docs/agent-config).

```ts
// agent/index.ts
import { openai } from "@ai-sdk/openai";
import { cachedModel } from "@upstash/agentkit-eve/model";
import { redis } from "./redis";

export const model = cachedModel({ model: openai("gpt-5.4-mini"), redis });
```

## Rate limiting (`agent/index.ts`)

```ts
// agent/index.ts
import { openai } from "@ai-sdk/openai";
import { cachedModel, rateLimitedModel } from "@upstash/agentkit-eve/model";
import { redis } from "./redis";

export const model = rateLimitedModel({ model: openai("gpt-5.4-mini"), redis, limit: 20, window: "1 m" });
```

Use both by nesting the wrappers, or apply both middlewares in one `wrapLanguageModel`:

```ts
// agent/index.ts
import { wrapLanguageModel } from "ai";
import { modelCacheMiddleware, rateLimitMiddleware } from "@upstash/agentkit-eve/model";

export const model = wrapLanguageModel({
  model: openai("gpt-5.4-mini"),
  middleware: [rateLimitMiddleware({ redis }), modelCacheMiddleware({ redis })],
});
```

## Cached tools (`agent/tools/*.ts`)

`defineCachedTool` is like Eve's `defineTool`, but its result is memoized — pass a `cachePrefix`
(string, or a function of the input + context). `redis` defaults to env. See
[tools](https://eve.dev/docs/tools).

```ts
// agent/tools/get_weather.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { defineCachedTool } from "@upstash/agentkit-eve";

export default defineTool(
  defineCachedTool({
    description: "Get the current weather for a city.",
    inputSchema: z.object({ city: z.string() }),
    cachePrefix: "get_weather",
    execute: async ({ city }) => fetchWeather(city),
  }),
);
```

## Memory tools (`agent/tools/*.ts`)

`defineMemoryRecallTool` and `defineMemorySaveTool` return ready `defineTool` configs — one file
each, one import. Pass a `scope` (a string shared across users, or a function deriving it from the
context); `redis` defaults to env.

```ts
// agent/tools/recall_memory.ts
import { defineTool } from "eve/tools";
import { defineMemoryRecallTool } from "@upstash/agentkit-eve";

export default defineTool(defineMemoryRecallTool({ scope: (_, ctx) => ctx.session.id }));
```

```ts
// agent/tools/save_memory.ts
import { defineTool } from "eve/tools";
import { defineMemorySaveTool } from "@upstash/agentkit-eve";

export default defineTool(defineMemorySaveTool({ scope: (_, ctx) => ctx.session.id }));
```

## Code-execution sandbox (`agent/sandbox.ts`)

`upstash()` is a drop-in replacement for Eve's `vercel()` backend, powered by Upstash Box. Swap the
backend import and keep the rest of your [sandbox file](https://eve.dev/docs/sandbox) the same.

```ts
// agent/sandbox.ts
import { defineSandbox } from "eve/sandbox";
import { upstash } from "@upstash/agentkit-eve/sandbox"; // was: import { vercel } from "eve/sandbox/vercel"

export default defineSandbox({
  backend: upstash({ runtime: "node24", resources: { vcpus: 2 } }),
  revalidationKey: () => "repo-bootstrap-v1",
  async bootstrap({ use }) {
    const sandbox = await use();
    await sandbox.run({ command: "apt-get install -y jq" });
  },
  async onSession({ use }) {
    await use({ networkPolicy: "deny-all" });
  },
});
```

Set `UPSTASH_BOX_API_KEY` (or pass `apiKey`). `@upstash/box` is an optional peer dependency — only
needed when you import `@upstash/agentkit-eve/sandbox`.

## Testing

Tests run against a **real Upstash Redis** (and a real Box when `UPSTASH_BOX_API_KEY` is set); only
LLM calls are mocked. Set `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (suites skip when
absent).

## License

MIT
