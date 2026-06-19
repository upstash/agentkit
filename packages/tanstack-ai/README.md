# @upstash/agentkit-tanstack-ai

TanStack AI adapter for [Upstash AgentKit](../sdk). It plugs the core AgentKit primitives —
persistent chat history, semantic caching, tool caching/sandboxing, and long-term memory — into the
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

## Tool caching & sandboxing

Wrap TanStack-style tools so execution is memoized via `ToolCache` and/or hardened by `Sandbox`
(timeout, retries, telemetry). Two identical calls only run the underlying tool once.

```ts
import { ToolCache, Sandbox } from "@upstash/agentkit-sdk";
import { wrapTools } from "@upstash/agentkit-tanstack-ai";

const tools = wrapTools(myTools, {
  toolCache: new ToolCache({ redis }),
  sandbox: new Sandbox({ timeoutMs: 10_000, maxRetries: 2 }),
});
```

## Semantic cache & memory

`withSemanticCache` reuses model responses for semantically similar prompts.
`withMemory` recalls long-term memories and formats them as a context message to prepend.

```ts
import { SemanticCache, AgentMemory } from "@upstash/agentkit-sdk";
import { withSemanticCache, withMemory } from "@upstash/agentkit-tanstack-ai";

const generate = withSemanticCache(model.generate, {
  cache: new SemanticCache({ vector }),
});

const injector = withMemory({ memory: new AgentMemory({ vector }), scope: "user-1" });
const context = await injector.recall(userQuestion);
const conversation = context ? [context, ...messages] : messages;
```

## License

MIT
