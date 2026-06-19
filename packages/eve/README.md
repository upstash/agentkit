# @upstash/agentkit-eve

Adapter that brings [Upstash AgentKit](https://upstash.com/) to **Eve, the Vercel agent framework**.
Eve is file-centric, so this package ships small pieces you drop into your `agent/` tree: long-term
memory tools, a real code-execution **sandbox backend** powered by [Upstash Box](https://github.com/upstash/box),
cached tools, and a rate-limited model wrapper.

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

## Memory tools (`agent/tools/*.ts`)

`defineMemoryRecallTool` and `defineMemorySaveTool` return ready `defineTool` configs — one file each,
one import. Pass a `namespace` (a string shared across users, or a function deriving it from the
context); `redis` defaults to env. Memories are stored at `agentkit:memory:<namespace>:<id>`.

```ts
// agent/tools/recall_memory.ts
import { defineTool } from "eve/tools";
import { defineMemoryRecallTool } from "@upstash/agentkit-eve";

export default defineTool(
  defineMemoryRecallTool({
    namespace: (_, ctx) => ctx.session.id, // the memory scope — a string, or (input, ctx) => string
    redis, // optional: Upstash Redis client (defaults to Redis.fromEnv())
    topK: 5, // optional: max memories to return
    minScore: 0, // optional: BM25 relevance floor for recall
    // memory, // optional: a pre-built AgentMemory (overrides `redis`)
  }),
);
```

```ts
// agent/tools/save_memory.ts
import { defineTool } from "eve/tools";
import { defineMemorySaveTool } from "@upstash/agentkit-eve";

export default defineTool(
  defineMemorySaveTool({
    namespace: (_, ctx) => ctx.session.id, // the memory scope — a string, or (input, ctx) => string
    redis, // optional: Upstash Redis client (defaults to Redis.fromEnv())
  }),
);
```

## Code-execution sandbox (`agent/sandbox.ts`)

`upstash()` is a drop-in replacement for Eve's `vercel()` backend, powered by Upstash Box. Swap the
backend import and keep the rest of your [sandbox file](https://eve.dev/docs/sandbox) the same.

```ts
// agent/sandbox.ts
import { defineSandbox } from "eve/sandbox";
import { upstash } from "@upstash/agentkit-eve/sandbox"; // was: import { vercel } from "eve/sandbox/vercel"

export default defineSandbox({
  backend: upstash({
    runtime: "node24", // the Upstash Box runtime (node | python | golang | ruby | rust)
    resources: { vcpus: 2 }, // optional: requested resources
    // apiKey, // optional: Upstash Box API key (defaults to UPSTASH_BOX_API_KEY)
  }),
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

## Cached tools (`agent/tools/*.ts`)

`defineCachedTool` is like Eve's `defineTool`, but its result is memoized — pass a `namespace` (string,
or a function of the input + context). `redis` defaults to env. Keys are
`agentkit:toolCache:<namespace>:<hash>`.

```ts
// agent/tools/get_weather.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { defineCachedTool } from "@upstash/agentkit-eve";

export default defineTool(
  defineCachedTool({
    description: "Get the current weather for a city.", // (defineTool field) shown to the model
    inputSchema: z.object({ city: z.string() }), // (defineTool field) zod schema for the input
    execute: async ({ city }) => fetchWeather(city), // (defineTool field) memoized
    namespace: "get_weather", // the cache key — a string, or (input, ctx) => string
    redis, // optional: Upstash Redis client (defaults to Redis.fromEnv())
    ttlSeconds: 600, // optional: per-result TTL in seconds (default: no expiry)
    // toolCache, // optional: a pre-built ToolCache (overrides `redis`)
  }),
);
```

## Rate limiting (`agent/agent.ts`)

Wrap your agent's model with `rateLimitedModel` (re-exported from the AI SDK adapter — Eve uses Vercel
AI SDK models). Keys are `agentkit:rateLimit:<identifier>`. See [agent config](https://eve.dev/docs/agent-config).

```ts
// agent/agent.ts
import { openai } from "@ai-sdk/openai";
import { rateLimitedModel } from "@upstash/agentkit-eve";
import { redis } from "./redis";

export const model = rateLimitedModel({
  model: openai("gpt-5.4-mini"), // the language model to wrap
  redis, // optional: Upstash Redis client (defaults to Redis.fromEnv())
  limit: 20, // optional: requests allowed per window (default: 10)
  window: "1 m", // optional: sliding-window duration, e.g. "10 s" / "1 m" (default: "60 s")
  namespace: "agentkit:rateLimit", // optional: key prefix string; keys are `<namespace>:<identifier>`
  identifier: "global", // optional: per-user id — string or () => string | Promise<string> (default: "global")
  onLimit: "throw", // optional: "throw" a RateLimitExceededError (default) or "wait" for a free token
  waitTimeoutMs: 10000, // optional: max wait when onLimit is "wait" (default: 10000)
});
```

## Testing

Tests run against a **real Upstash Redis** (and a real Box when `UPSTASH_BOX_API_KEY` is set); only
LLM calls are mocked. Set `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (suites skip when
absent).

## License

MIT
