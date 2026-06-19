# @upstash/agentkit-eve

Adapter that wires [Upstash AgentKit](https://upstash.com/) into **Eve, the Vercel agent
framework**. It brings the core [`@upstash/agentkit-sdk`](https://www.npmjs.com/package/@upstash/agentkit-sdk)
primitives — chat history, semantic & tool caching, agent memory, and RAG — to an Eve agent, plus a
real code-execution sandbox backend (Upstash Box).

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

### Cached tools

```ts
import { cacheTools } from "@upstash/agentkit-eve";
import { ToolCache } from "@upstash/agentkit-sdk";

const tools = cacheTools(agent.tools, { toolCache: new ToolCache({ redis }) });
```

### Code-execution sandbox — `upstash()` backend

A drop-in replacement for Eve's `vercel()` backend, powered by [Upstash Box](https://github.com/upstash/box).
Take any Eve sandbox file and swap the backend import — everything else stays the same:

```ts
import { defineSandbox } from "eve/sandbox";
import { upstash } from "@upstash/agentkit-eve/sandbox";

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

Set `UPSTASH_BOX_API_KEY` (or pass `apiKey`). Each session is a real Box: `run`, `readTextFile` /
`writeTextFile`, `setNetworkPolicy`, `getPublicURL`, `stop`/`destroy`, and `.box` for the full SDK.

Optionally memoize every `session.run` via a ToolCache:

```ts
import { withSandboxInstrumentation } from "@upstash/agentkit-eve/sandbox";
import { ToolCache } from "@upstash/agentkit-sdk";

export default defineSandbox(
  withSandboxInstrumentation(
    { backend: upstash(), async onSession({ use }) { await (await use()).run({ command: "npm test" }); } },
    { toolCache: new ToolCache({ redis }) },
  ),
);
```

### Memory, history, semantic cache

```ts
import { AgentMemory, ChatHistory, SemanticCache } from "@upstash/agentkit-sdk";
import { createMemoryHooks, createHistoryHooks, withSemanticCache } from "@upstash/agentkit-eve";

const memory = createMemoryHooks({ memory: new AgentMemory({ redis }), scope: "user-123" });
const history = createHistoryHooks({ history: new ChatHistory({ redis }), sessionId: "s-1" });
const cachedGenerate = withSemanticCache(generate, { cache: new SemanticCache({ redis }) });
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
