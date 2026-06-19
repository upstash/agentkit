# @upstash/agentkit-eve

Adapter that wires [Upstash AgentKit](https://upstash.com/) into **Eve, the Vercel agent
framework**. It brings the core [`@upstash/agentkit-sdk`](https://www.npmjs.com/package/@upstash/agentkit-sdk)
primitives — chat history, semantic & tool caching, telemetry, agent memory, and RAG — to an Eve
agent, plus an integration for Eve's own code-execution sandbox.

```bash
pnpm add @upstash/agentkit-eve @upstash/agentkit-sdk @upstash/redis
# in your app:
pnpm add eve
```

> The adapter never imports `eve` — it codes against structural shapes, so it builds and tests fully
> offline. `eve` is an _optional_ peer dependency; `@upstash/redis` is required. Everything is backed
> by Upstash Redis (search uses Redis Search's `$smart` fuzzy operator — no vector database).

## `withAgentKit`

Returns an augmented copy of your Eve agent config whose tools are cached + traced and whose
instructions are augmented with recalled memories / RAG context. Pass only the `redis` client:

```ts
import { Redis } from "@upstash/redis";
import { withAgentKit } from "@upstash/agentkit-eve";

const redis = Redis.fromEnv();

const { agent, history, memory, trace } = await withAgentKit(
  { instructions: "You are a helpful assistant.", tools, model },
  { redis, sessionId: "session-1", scope: "user-123", useMemory: true, context: userInput },
);

const prior = await history?.load();
const text = await trace("run", () => runEveAgent(agent, [...(prior ?? []), userMessage]));
```

## Pieces

### Cached + traced tools

```ts
import { cacheTools } from "@upstash/agentkit-eve";
import { ToolCache, Telemetry } from "@upstash/agentkit-sdk";

const tools = cacheTools(agent.tools, {
  toolCache: new ToolCache({ redis }),
  telemetry: new Telemetry({ redis }),
});
```

### Code-execution sandbox (Eve's `eve/sandbox`)

Instrument [Eve's sandbox](https://eve.dev/docs/sandbox) so each `session.run(...)` is traced and
memoized, without bundling a sandbox runtime:

```ts
import { defineSandbox } from "eve/sandbox";
import { withSandboxInstrumentation } from "@upstash/agentkit-eve";
import { Telemetry, ToolCache } from "@upstash/agentkit-sdk";

export default defineSandbox(
  withSandboxInstrumentation(
    {
      async onSession({ use }) {
        const sandbox = await use({ networkPolicy: "deny-all" });
        await sandbox.run({ command: "npm test" }); // traced + cached
      },
    },
    { telemetry: new Telemetry({ redis }), toolCache: new ToolCache({ redis }) },
  ),
);
```

### Memory, history, semantic cache, telemetry

```ts
import { AgentMemory, ChatHistory, SemanticCache, Telemetry } from "@upstash/agentkit-sdk";
import {
  createMemoryHooks,
  createHistoryHooks,
  withSemanticCache,
  traceRun,
} from "@upstash/agentkit-eve";

const memory = createMemoryHooks({ memory: new AgentMemory({ redis }), scope: "user-123" });
const history = createHistoryHooks({ history: new ChatHistory({ redis }), sessionId: "s-1" });
const cachedGenerate = withSemanticCache(generate, { cache: new SemanticCache({ redis }) });
await traceRun({ telemetry: new Telemetry({ redis }) }, "run", async (span) => {
  /* ... */
});
```

## Testing

Tests run against a **real Upstash Redis** (no Redis mock); only the LLM is mocked via `MockModel`.
Set `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (suites skip when absent).

```ts
import { MockModel } from "@upstash/agentkit-sdk/testing";
```

> The structural Eve types may need adjusting as Eve stabilizes.

## License

MIT
