# @upstash/agentkit-tanstack-ai

TanStack AI adapter for [Upstash AgentKit](../sdk). It plugs the core AgentKit primitives —
persistent chat history, semantic caching, tool caching, and long-term memory — into the
TanStack ecosystem's AI/chat primitives.

Like the core SDK, this package never imports a real TanStack package at runtime. It codes against
minimal **structural interfaces**, so `@tanstack/ai` is only an _optional_ peer dependency and the
package builds and tests fully offline.

## Install

```bash
pnpm add @upstash/agentkit-tanstack-ai @upstash/agentkit-sdk
# @tanstack/ai is an optional peer — install it in your app as needed
```

## Message conversion

Convert between AgentKit `ChatMessage[]` and TanStack-AI-style messages. Conversion is lossless: a
TanStack `id` is preserved in `metadata.id` and surfaced again on the way back.

```ts
import { toTanStackMessages, fromTanStackMessages } from "@upstash/agentkit-tanstack-ai";

const tsMessages = toTanStackMessages(agentKitMessages);
const back = fromTanStackMessages(tsMessages);
```

## Persistent chat history

Back a TanStack chat store with Redis via AgentKit's `ChatHistory`.

```ts
import { ChatHistory } from "@upstash/agentkit-sdk";
import { createChatHistoryAdapter } from "@upstash/agentkit-tanstack-ai";

const adapter = createChatHistoryAdapter({
  history: new ChatHistory({ redis }),
  limit: 50,
});

await adapter.addMessage("session-1", { role: "user", content: "Hi" });
const messages = await adapter.getMessages("session-1");
await adapter.clear("session-1");
```

## Server-side chat handler

Loads prior history, runs your (injectable) generate function, and persists **both** the user and
assistant messages per turn.

```ts
import { createChatHandler } from "@upstash/agentkit-tanstack-ai";

const handler = createChatHandler({
  history,
  generate: async (messages) => callYourModel(messages), // returns string or a message
});

const { message, messages } = await handler({ sessionId: "s1", message: "Hello" });
```

## Tool caching

Wrap TanStack-style tools so execution is memoized via `ToolCache`. Two identical calls only run the
underlying tool once.

```ts
import { ToolCache } from "@upstash/agentkit-sdk";
import { wrapTools } from "@upstash/agentkit-tanstack-ai";

const tools = wrapTools(myTools, {
  toolCache: new ToolCache({ redis }),
  ttlSeconds: 300, // optional per-result TTL
});
```

## Semantic cache & memory

`withSemanticCache` reuses model responses for semantically similar prompts.
`withMemory` recalls long-term memories and formats them as a context message to prepend.

```ts
import { SemanticCache, AgentMemory } from "@upstash/agentkit-sdk";
import { withSemanticCache, withMemory } from "@upstash/agentkit-tanstack-ai";

const generate = withSemanticCache(model.generate, {
  cache: new SemanticCache({ redis }),
});

const injector = withMemory({ memory: new AgentMemory({ redis }), scope: "user-1" });
const context = await injector.recall(userQuestion);
const conversation = context ? [context, ...messages] : messages;
```

`redis` is an `@upstash/redis` client; each feature owns its search index internally.

## Testing

The test suite runs against a **real Upstash Redis** instance — only the LLM is mocked (via
`MockModel` from `@upstash/agentkit-sdk/testing`). Set `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN` (e.g. in the repo-root `.env`); when they're absent the Redis-backed
suites skip themselves automatically.

## License

MIT
