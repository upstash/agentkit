# @upstash/agentkit-eve

[Eve](https://vercel.com/) (the new Vercel agent framework) adapter for
[Upstash AgentKit](https://upstash.com/). It wires the core
[`@upstash/agentkit-sdk`](https://www.npmjs.com/package/@upstash/agentkit-sdk) primitives — chat
history, semantic & tool caching, telemetry, sandbox, agent memory, and RAG — into an Eve agent.

```bash
pnpm add @upstash/agentkit-eve @upstash/agentkit-sdk
# plus, in your app, the Eve framework and Upstash clients:
pnpm add eve @upstash/redis
```

> **A note on the Eve types.** Eve is new and its API is still stabilizing. This adapter never
> imports an `eve` package — instead it codes against small **structural interfaces** it defines
> itself (`EveTool`, `EveAgentConfig`, `EveMessage`, …), exactly as the core SDK avoids importing
> `@upstash/redis`. `eve` is an _optional_ peer dependency, so the package builds and tests fully
> offline. As Eve stabilizes you may need to adjust these structural shapes; they are documented
> in `src/types.ts`.

## One-shot wiring with `withAgentKit`

`withAgentKit` returns an augmented copy of your Eve agent config whose tools are sandboxed +
cached, whose instructions are augmented with recalled memories and/or RAG context, plus hooks for
persistent history and traced runs. Nothing is mutated; everything is opt-in by what you pass.

```ts
import { Redis } from "@upstash/redis";
import { upstashSearchStore } from "@upstash/agentkit-sdk";
import { withAgentKit } from "@upstash/agentkit-eve";

const redis = Redis.fromEnv();
const search = upstashSearchStore(redis.search.index({ name: "agentkit", schema }));

const { agent, history, trace } = await withAgentKit(
  { instructions: "You are a helpful assistant.", tools, model },
  {
    redis,
    search,
    sessionId: "session-1",
    scope: "user-123",
    useMemory: true,
    context: userInput, // seed for memory recall / RAG retrieval
  },
);

const prior = await history?.load();
const text = await trace("eve-run", () =>
  runEveAgent(agent, [...(prior ?? []), { role: "user", content: userInput }]),
);
await history?.append({ role: "assistant", content: text });
```

## Composable helpers

### Sandboxed + cached tools

```ts
import { sandboxTools } from "@upstash/agentkit-eve";
import { ToolCache } from "@upstash/agentkit-sdk";

const safeTools = sandboxTools(tools, {
  sandboxConfig: { timeoutMs: 10_000, maxRetries: 2 },
  toolCache: new ToolCache({ redis }),
});
// Each tool's execute now runs with a timeout, retries, abort via ctx.signal, and result caching.
```

### Memory hooks

```ts
import { AgentMemory } from "@upstash/agentkit-sdk";
import { createMemoryHooks } from "@upstash/agentkit-eve";

const hooks = createMemoryHooks({ memory: new AgentMemory({ search }), scope: "user-123" });
await hooks.remember("The user prefers TypeScript");
const context = await hooks.recall("language preference"); // -> formatted memory block
```

### History hooks

```ts
import { ChatHistory } from "@upstash/agentkit-sdk";
import { createHistoryHooks } from "@upstash/agentkit-eve";

const hooks = createHistoryHooks({
  history: new ChatHistory({ redis }),
  sessionId: "session-1",
});
const prior = await hooks.load();
await hooks.append({ role: "user", content: "Hello" });
```

### Semantic-cached generation

```ts
import { SemanticCache } from "@upstash/agentkit-sdk";
import { withSemanticCache } from "@upstash/agentkit-eve";

const cachedGenerate = withSemanticCache(
  (args) => eveModel.generate({ prompt: args.prompt }),
  { cache: new SemanticCache({ search }) },
);
const { text } = await cachedGenerate({ prompt: "What is the capital of France?" });
```

### Traced runs

```ts
import { Telemetry } from "@upstash/agentkit-sdk";
import { traceRun } from "@upstash/agentkit-eve";

const telemetry = new Telemetry({ redis });
const text = await traceRun({ telemetry }, "eve-agent-run", async (span) => {
  span.setAttribute("model", "claude-opus-4-8");
  return runEveAgent(agent, messages);
});
```

## Testing

All helpers are unit-testable offline with the core SDK's test doubles — no network, no real LLM:

```ts
import { MemoryRedis, MemorySearchStore, MockModel } from "@upstash/agentkit-sdk/testing";
```

## License

MIT
