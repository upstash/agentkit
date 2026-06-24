# @upstash/agentkit-ai-sdk

[Vercel AI SDK](https://ai-sdk.dev) adapter for [Upstash AgentKit](https://www.npmjs.com/package/@upstash/agentkit-sdk).
It adds chat history, agent memory, Redis-Search tools, rate limiting, and tool caching to
`generateText` / `streamText`. `redis` defaults to `Redis.fromEnv()`, so you import only from this
package.

```bash
pnpm add @upstash/agentkit-ai-sdk @upstash/redis ai
```

## Chat history

A Redis-backed `ChatHistory<UIMessage>`, the durable source of truth for your conversations. `userId`
comes from your auth session; `chatId` is the `useChat` id that the client posts. Save the full
transcript from your route's `onFinish`:

```ts
// app/api/chat/route.ts
import { convertToModelMessages, createUIMessageStreamResponse, streamText, toUIMessageStream } from "ai";
import { createChatHistory } from "@upstash/agentkit-ai-sdk";

const history = createChatHistory();

export async function POST(req: Request) {
  const userId = await getSessionUserId(req); // your auth session — never trust a client-sent id
  const { id: chatId, messages } = await req.json(); // useChat posts its chat id + the full transcript

  const result = streamText({ model, messages: convertToModelMessages(messages) });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      originalMessages: messages,
      onFinish: ({ messages }) =>
        history.saveChat({ userId, sessionId: chatId, messages, title: "New chat" }),
    }),
  });
}
```

To load a chat, take `chatId` from the page route and `userId` from the session, then seed `useChat`:

```ts
const chat = await history.getChat({ userId, sessionId: chatId }); // full transcript, or null
const chats = await history.listChats({ userId, limit: 50 }); // summaries, no messages
const hits = await history.searchChats({ userId, query: "headphones", target: "both", limit: 20 });
// client: useChat({ id: chatId, messages: chat?.messages ?? [] })
```

<details>
<summary>Config &amp; how it's stored</summary>

```ts
createChatHistory({
  redis, // optional: defaults to Redis.fromEnv()
  prefix: "agentkit:chat", // optional: base key prefix
  indexName: "agentkit_chat", // optional: Redis Search index name (defaults to the prefix)
  ttlSeconds: 60 * 60 * 24 * 30, // optional: per-chat TTL (default: no expiry)
});
```

Each chat is one JSON doc at `agentkit:chat:<userId>:<sessionId>` (keyed per user, so two users can't
collide on a `sessionId`), indexed over `userId` + `sessionId` (filters) and `userMessages` +
`modelMessages` (`$smart` fuzzy text); the raw `messages` array rides along unindexed. `saveChat`
overwrites the **whole** array (no delta merge) — `useChat` sends the full conversation. Other methods:
`getChat` / `deleteChat` (`{ userId, sessionId }`), `listChats` / `searchChats` (`{ userId }`).

</details>

<details>
<summary>Security: <code>userId</code> is the tenant boundary</summary>

Every method takes a single object; `userId` is **required, non-empty, and may not contain `:`**.
**Derive it from a verified server-side auth source** — the subject/user id from your auth provider
(Clerk, Auth.js/NextAuth, Supabase Auth, Auth0, …) — and **never from a client-supplied header, query
param, or body** (read it from the session in your route, not the request the browser controls). A chat
can't be read or overwritten under a different `userId`.

</details>

## Agent memory

`recall_memory` and `save_memory` tools so the model reads and writes its own long-term memory.

```ts
import { createMemoryTools } from "@upstash/agentkit-ai-sdk";
import { generateText, stepCountIs } from "ai";

const tools = createMemoryTools({ userId });

await generateText({ model, tools, stopWhen: stepCountIs(5), prompt: "What do you know about me?" });
```

<details>
<summary>Options &amp; the <code>userId</code> tenant boundary</summary>

- **`userId`** _(required)_ — a string, or `(input, options) => string`.
- `redis` — defaults to `Redis.fromEnv()`.
- `topK` — max memories `recall` returns.
- `minScore` — BM25 relevance floor.
- `recallToolName` / `saveToolName` — override the tool names.

`userId` is the only tenant boundary (required, non-empty, no `:`). **Derive it from a verified
server-side auth source** (Clerk, Auth.js/NextAuth, Supabase Auth, Auth0, …) — never a client-supplied
value. Memories are stored at `agentkit:memory:<userId>:<id>`.

</details>

## Search tools

`search` / `aggregate` / `count` over an Upstash Redis Search index; the model-facing descriptions are
generated from your schema. Use these over your own documents for RAG.

```ts
import { s } from "@upstash/redis";
import { createSearchTools } from "@upstash/agentkit-ai-sdk";
import { generateText, stepCountIs } from "ai";

const schema = s.object({ name: s.string(), age: s.number(), city: s.string().noTokenize() });
const tools = createSearchTools({ schema, indexName: "users" });

await generateText({ model, tools, stopWhen: stepCountIs(5), prompt: "How many users named Ada live in London?" });
```

<details>
<summary>Options</summary>

- **`schema`** _(required)_ — built with `s` from `@upstash/redis`.
- `redis` — defaults to `Redis.fromEnv()`.
- `indexName` — defaults to `"agentkit:search"`.
- `prefix` — key prefix for indexed JSON docs (defaults to `"<indexName>:"`).
- `defaultLimit` — default page size for `search` (10).

The index is created (and `waitIndexing`-ed) reactively on first use — no setup step.

</details>

## Rate limiting

A configured [Upstash Ratelimit](https://github.com/upstash/ratelimit-js). Call `.limit(identifier)`
before the model and short-circuit when over the limit.

```ts
import { createRateLimit, Ratelimit } from "@upstash/agentkit-ai-sdk";

const ratelimit = createRateLimit({ limiter: Ratelimit.slidingWindow(20, "1 m") });

const { success } = await ratelimit.limit(userId);
if (!success) throw new Error("rate limited"); // or return a 429 from your route
```

<details>
<summary>Options</summary>

- **`limiter`** _(required)_ — e.g. `Ratelimit.slidingWindow(20, "1 m")` or `fixedWindow(...)`.
- `redis` — defaults to `Redis.fromEnv()`.
- `prefix` — base key prefix; keys are `<prefix>:<identifier>` (default `agentkit:rateLimit`).

There is no model wrapper; pass a per-user `identifier` to `.limit()` to throttle per user.

</details>

## Tool cache

Memoize a map of AI SDK tools' results in Redis. Each tool is cached under its map key, scoped to
`userId`.

```ts
import { z } from "zod";
import { generateText, tool } from "ai";
import { cachedTools } from "@upstash/agentkit-ai-sdk";

const tools = cachedTools(
  {
    getWeather: tool({
      description: "Get the weather for a city",
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => fetchWeather(city),
    }),
  },
  { userId },
);

await generateText({ model, tools, prompt: "What's the weather in Paris?" });
```

<details>
<summary>Options</summary>

Pass tools built with the AI SDK's `tool()` (so each keeps full input/output inference). Second arg:

- **`userId`** _(required)_ — a string, or `(input, options) => string`; scopes every entry to this user.
- `redis` — defaults to `Redis.fromEnv()`.
- `ttlSeconds` — default per-result TTL for every tool.

Cache keys are `agentkit:toolCache:<userId>:<toolName>:<hash-of-input>` — the `toolName` is the map key,
so you never pass a name yourself.

</details>

## Testing

Tests run against a **real Upstash Redis** (only LLM calls are mocked). Set `UPSTASH_REDIS_REST_URL` /
`UPSTASH_REDIS_REST_TOKEN` (suites skip when absent).

## License

MIT
