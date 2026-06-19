# @upstash/agentkit-ai-sdk

[Vercel AI SDK](https://ai-sdk.dev) adapter for [Upstash AgentKit](https://www.npmjs.com/package/@upstash/agentkit-sdk).
Everything is a drop-in for `generateText` / `streamText`: ready-made memory + Redis-Search tools, a
self-contained cached tool, and a rate-limited model wrapper. `redis` defaults to `Redis.fromEnv()`
everywhere, so you import only from this package.

```bash
pnpm add @upstash/agentkit-ai-sdk @upstash/redis ai
```

## Agent memory

`createMemoryTools` returns `recall_memory` and `save_memory` tools so the model can read and write
long-term memory itself. Memories are stored at `agentkit:memory:<namespace>:<id>`.

```ts
import { createMemoryTools } from "@upstash/agentkit-ai-sdk";
import { generateText, stepCountIs } from "ai";

const tools = createMemoryTools({
  namespace: userId, // the memory scope — a string, or (input, options) => string (e.g. a user id)
  redis, // optional: Upstash Redis client (defaults to Redis.fromEnv())
  topK: 5, // optional: max memories the recall tool returns
  minScore: 0, // optional: BM25 relevance floor for recall
  recallToolName: "recall_memory", // optional: override the recall tool's name
  saveToolName: "save_memory", // optional: override the save tool's name
  // memory, // optional: a pre-built AgentMemory (overrides `redis`)
});

await generateText({ model, tools, stopWhen: stepCountIs(5), prompt: "What do you know about me?" });
```

## Search tools

`createSearchTools` returns `search` / `aggregate` / `count` tools over an Upstash Redis Search index.
The tool descriptions are generated from your `s.object(...)` schema, so the model learns the fields,
their types, and which filter operators (`$smart`, `$lt`, `$in`, `$and`, …) apply. The index is
created (and `waitIndexing`-ed) automatically on first use.

```ts
import { s } from "@upstash/redis";
import { createSearchTools } from "@upstash/agentkit-ai-sdk";
import { generateText, stepCountIs } from "ai";

const schema = s.object({ name: s.string(), age: s.number(), city: s.string().noTokenize() });

const tools = createSearchTools({
  schema, // the Upstash Redis Search schema (built with `s` from @upstash/redis)
  redis, // optional: Upstash Redis client (defaults to Redis.fromEnv())
  name: "users", // optional: index name (defaults to "agentkit:search")
  prefix: "users:", // optional: key prefix for indexed JSON docs (defaults to "<name>:")
  ensureIndex: true, // optional: create the index + waitIndexing before the tools run (defaults to true)
  defaultLimit: 10, // optional: default page size for the `search` tool (defaults to 10)
});

await generateText({
  model,
  tools,
  stopWhen: stepCountIs(5),
  prompt: "How many users named Ada live in London?",
});
```

## Tool cache

`cachedTool` is the AI SDK's `tool()` with its `execute` memoized in Redis — same config (so
`inputSchema` still infers `execute`'s input), plus the cache options. Cache keys are
`agentkit:toolCache:<namespace>:<hash-of-input>`.

```ts
import { z } from "zod";
import { generateText } from "ai";
import { cachedTool } from "@upstash/agentkit-ai-sdk";

const getWeather = cachedTool({
  description: "Get the weather for a city", // (AI SDK tool field) shown to the model
  inputSchema: z.object({ city: z.string() }), // (AI SDK tool field) zod/Standard Schema — types `execute`
  execute: async ({ city }) => fetchWeather(city), // (AI SDK tool field) memoized; `city` is inferred
  namespace: "getWeather", // the cache key — a string, or (input, options) => string
  redis, // optional: Upstash Redis client (defaults to Redis.fromEnv())
  ttlSeconds: 600, // optional: per-result TTL in seconds (default: no expiry)
});

await generateText({ model, tools: { getWeather }, prompt: "What's the weather in Paris?" });
```

Cache a whole map at once with `cachedTools` — pass tools built with the AI SDK's `tool()` (so each
keeps full type inference); each is cached under its map key, so there's no per-tool namespace.

```ts
import { z } from "zod";
import { generateText, tool } from "ai";
import { cachedTools } from "@upstash/agentkit-ai-sdk";

const tools = cachedTools(
  {
    getWeather: tool({
      description: "Get the weather for a city",
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => fetchWeather(city), // cached under "getWeather"
    }),
  },
  {
    redis, // optional: Upstash Redis client shared by every tool (defaults to Redis.fromEnv())
    ttlSeconds: 600, // optional: default per-result TTL in seconds for every tool
  },
);

await generateText({ model, tools, prompt: "What's the weather in Paris?" });
```

## Rate limiting

`rateLimitedModel` wraps a model so each call is rate-limited with
[Upstash Ratelimit](https://github.com/upstash/ratelimit-js) — throwing (or waiting) when the limit
is exceeded. Build the model per request with a per-user `identifier` to limit by user. Keys are
`agentkit:rateLimit:<identifier>`.

```ts
import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import { rateLimitedModel } from "@upstash/agentkit-ai-sdk";

const model = rateLimitedModel({
  model: openai("gpt-5.4-mini"), // the language model to wrap
  redis, // optional: Upstash Redis client (defaults to Redis.fromEnv())
  limit: 20, // optional: requests allowed per window (default: 10)
  window: "1 m", // optional: sliding-window duration, e.g. "10 s" / "1 m" (default: "60 s")
  namespace: "agentkit:rateLimit", // optional: key prefix string; keys are `<namespace>:<identifier>`
  identifier: userId, // optional: per-user id — string or () => string | Promise<string> (default: "global")
  onLimit: "throw", // optional: "throw" a RateLimitExceededError (default) or "wait" for a free token
  waitTimeoutMs: 10000, // optional: max wait when onLimit is "wait" (default: 10000)
  // ratelimit, // optional: a pre-built @upstash/ratelimit Ratelimit (overrides limit/window)
});

await generateText({ model, prompt: "..." }); // throws RateLimitExceededError once over the limit
```

## Testing

Tests run against a **real Upstash Redis** (only LLM calls are mocked). Set
`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (suites skip when absent).

## License

MIT
