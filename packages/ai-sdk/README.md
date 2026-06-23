# @upstash/agentkit-ai-sdk

[Vercel AI SDK](https://ai-sdk.dev) adapter for [Upstash AgentKit](https://www.npmjs.com/package/@upstash/agentkit-sdk).
Everything is a drop-in for `generateText` / `streamText`: durable chat history, ready-made memory +
Redis-Search tools, a rate limiter you call before the model, and self-contained cached tools.
`redis` defaults to `Redis.fromEnv()` everywhere, so you import only from this package.

```bash
pnpm add @upstash/agentkit-ai-sdk @upstash/redis ai
```

## Chat history

`createChatHistory` returns a Redis-backed `ChatHistory<UIMessage>` — the durable source of truth for
your conversations. Each chat is one JSON doc at `agentkit:chat:<userId>:<sessionId>` (keyed per user,
so two users can't collide on a `sessionId`), indexed over `userId` +
`sessionId` (filters) and `userMessages` + `modelMessages` (`$smart` fuzzy text); the raw `messages`
array and `metadata` ride along **unindexed**.

```ts
import { createChatHistory } from "@upstash/agentkit-ai-sdk";

const history = createChatHistory({
  redis, // optional: Upstash Redis client (defaults to Redis.fromEnv())
  namespace: "agentkit:chat", // optional: key prefix + index name base (defaults to "agentkit:chat")
  ttlSeconds: 60 * 60 * 24 * 30, // optional: per-chat TTL in seconds (default: no expiry)
});
```

Every method takes a single object; `userId` is **required, non-empty, and must be unique per user**
(your auth subject id). It's the tenant boundary — a chat can't be read or overwritten under a
different `userId`. `saveChat` overwrites the **whole** message array — `useChat` sends the full
conversation, so there's no transport trimming and no delta to merge. Persist from your route's
`onFinish`:

```ts
// app/api/chat/route.ts
import { createUIMessageStreamResponse, streamText, toUIMessageStream } from "ai";

const result = streamText({ model, messages: convertToModelMessages(messages) });

return createUIMessageStreamResponse({
  stream: toUIMessageStream({
    stream: result.stream,
    originalMessages: messages, // so onFinish receives the full UIMessage[] (request + reply)
    onFinish: ({ messages }) => history.saveChat({ userId, sessionId: chatId, messages, title }), // overwrite the whole array
  }),
});
```

Seed `useChat` with the stored transcript when loading a chat, and use `listChats` / `searchChats`
for a sidebar:

```ts
// page loader (server)
const chat = await history.getChat({ userId, sessionId: chatId }); // full transcript, or null
const chats = await history.listChats({ userId, limit: 50 }); // sidebar: summaries, no messages
const hits = await history.searchChats({ userId, query: "headphones", target: "both", limit: 20, minScore: 0 });

// client — hand the stored messages straight to useChat
// const { messages } = useChat({ id: chatId, messages: chat?.messages ?? [] });
```

Other methods: `createChat(userId, { sessionId?, title?, messages?, metadata? })`,
`setTitle(userId, sessionId, title)`, `deleteChat(userId, sessionId)`.

## Agent memory

`createMemoryTools` returns `recall_memory` and `save_memory` tools so the model can read and write
long-term memory itself. Memories are stored at `agentkit:memory:<namespace>:<id>`.

```ts
import { createMemoryTools } from "@upstash/agentkit-ai-sdk";
import { generateText, stepCountIs } from "ai";

const tools = createMemoryTools({
  namespace: userId, // required, non-empty: the memory scope — unique per user (a string, or (input, options) => string)
  redis, // optional: Upstash Redis client (defaults to Redis.fromEnv())
  topK: 5, // optional: max memories the recall tool returns
  minScore: 0, // optional: BM25 relevance floor for recall
  recallToolName: "recall_memory", // optional: override the recall tool's name
  saveToolName: "save_memory", // optional: override the save tool's name
});

await generateText({ model, tools, stopWhen: stepCountIs(5), prompt: "What do you know about me?" });
```

> **`namespace` is required and must be non-empty** — it's the only tenant boundary for memory.
> Make it **unique per user** (pass the user id, or a `(input, options) => string` deriving it); an
> empty value throws rather than collapsing every user into one shared bucket.

## Search tools

`createSearchTools` returns `search` / `aggregate` / `count` tools over an Upstash Redis Search index.
The tool descriptions are generated from your `s.object(...)` schema, so the model learns the fields,
their types, and which filter operators (`$smart`, `$lt`, `$in`, `$and`, …) apply. The index is
created (and `waitIndexing`-ed) **reactively** on first use — no setup step.

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
  defaultLimit: 10, // optional: default page size for the `search` tool (defaults to 10)
});

await generateText({
  model,
  tools,
  stopWhen: stepCountIs(5),
  prompt: "How many users named Ada live in London?",
});
```

## Rate limiting

`createRateLimit` returns a configured [Upstash Ratelimit](https://github.com/upstash/ratelimit-js)
`Ratelimit` with AgentKit defaults. There is no model wrapper — call `.limit(identifier)` yourself
before `generateText` and short-circuit when you're over the limit. Keys are
`agentkit:rateLimit:<identifier>`.

```ts
import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import { createRateLimit, Ratelimit } from "@upstash/agentkit-ai-sdk";

const ratelimit = createRateLimit({
  redis, // the Upstash Redis client backing the limiter
  limit: 20, // optional: requests allowed per window (default: 10)
  window: "1 m", // optional: sliding-window duration, e.g. "10 s" / "1 m" (default: "60 s")
  namespace: "agentkit:rateLimit", // optional: key prefix string; keys are `<namespace>:<identifier>`
  limiter: Ratelimit.fixedWindow(20, "1 m"), // optional: a custom limiter overriding limit/window
});

const { success } = await ratelimit.limit(userId); // pass a per-user identifier to limit by user
if (!success) throw new Error("rate limited"); // or return a 429 from your route

await generateText({ model: openai("gpt-5.4-mini"), prompt: "..." });
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
  namespace: "getWeather", // required, non-empty: the cache key — a string, or (input, options) => string
  redis, // optional: Upstash Redis client (defaults to Redis.fromEnv())
  ttlSeconds: 600, // optional: per-result TTL in seconds (default: no expiry)
});

await generateText({ model, tools: { getWeather }, prompt: "What's the weather in Paris?" });
```

> **`namespace` is required and must be non-empty.** It's the cache-key prefix, so if a tool's result
> is **user-specific**, make it unique per user via the `(input, options) => string` form (e.g. derive
> the user id from `options`) — a static namespace caches one result across all users.

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

## Testing

Tests run against a **real Upstash Redis** (only LLM calls are mocked). Set
`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (suites skip when absent).

## License

MIT
