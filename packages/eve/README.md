# @upstash/agentkit-eve

Adapter that brings [Upstash AgentKit](https://upstash.com/) to **Eve, the Vercel agent framework**.
Eve is file-centric, so this package ships small pieces you drop into your `agent/` tree: cached
tools, long-term memory tools, model wrappers (semantic cache + rate limit), and a real
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

## Model wrappers (`agent/index.ts`)

Wrap your agent's model with a semantic cache and/or a rate limiter (re-exported from the AI SDK
adapter — Eve uses Vercel AI SDK models). See [agent config](https://eve.dev/docs/agent-config).

```ts
// agent/index.ts
import { openai } from "@ai-sdk/openai";
import { semanticCachedModel, rateLimitedModel } from "@upstash/agentkit-eve/model";
import { redis } from "./redis";

export const model = rateLimitedModel({
  model: semanticCachedModel({ model: openai("gpt-5.4-mini"), redis }),
  redis,
  limit: 20,
  window: "1 m",
});
```

## Cached tools (`agent/tools/*.ts`)

Wrap a tool's `execute` with `cachedExecute` so identical inputs are memoized. Eve uses the filename
as the tool name — pass it as the cache key. See [tools](https://eve.dev/docs/tools).

```ts
// agent/tools/get_weather.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { cachedExecute } from "@upstash/agentkit-eve";
import { ToolCache } from "@upstash/agentkit-sdk";
import { redis } from "../redis";

export default defineTool({
  description: "Get the current weather for a city.",
  inputSchema: z.object({ city: z.string() }),
  execute: cachedExecute("get_weather", async ({ city }) => fetchWeather(city), {
    toolCache: new ToolCache({ redis }),
  }),
});
```

## Memory tools (`agent/tools/*.ts`)

`recallMemoryTool` and `saveMemoryTool` return ready `defineTool` configs — one file each.

```ts
// agent/tools/recall_memory.ts
import { defineTool } from "eve/tools";
import { AgentMemory } from "@upstash/agentkit-sdk";
import { recallMemoryTool } from "@upstash/agentkit-eve";
import { redis } from "../redis";

export default defineTool(recallMemoryTool({ memory: new AgentMemory({ redis }), scope: "user-123" }));
```

```ts
// agent/tools/save_memory.ts
import { defineTool } from "eve/tools";
import { AgentMemory } from "@upstash/agentkit-sdk";
import { saveMemoryTool } from "@upstash/agentkit-eve";
import { redis } from "../redis";

export default defineTool(saveMemoryTool({ memory: new AgentMemory({ redis }), scope: "user-123" }));
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
