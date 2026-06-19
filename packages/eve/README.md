# @upstash/agentkit-eve

Adapter that brings [Upstash AgentKit](https://upstash.com/) to **Eve, the Vercel agent framework**.
Eve is file-centric, so this package ships small pieces you drop into your `agent/` tree: durable
chat history, long-term memory tools, schema-driven Redis-Search tools, a rate limiter you drive from
an eve `AuthFn`, a real code-execution **sandbox backend** powered by
[Upstash Box](https://github.com/upstash/box), and cached tools.

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

## Chat history

`createChatHistory` returns a Redis-backed `ChatHistory<EveMessage>` — the **durable source of truth**
for a conversation's transcript. eve keeps live sessions in its Workflow store, but that's pruned
1–30 days after a run completes (per your Vercel plan), so persist the transcript in Redis for durable
history, listing, and resume. Each chat is one JSON doc at `agentkit:chat:<sessionId>`, indexed over
`userId` + `sessionId` (filters) and `userMessages` + `modelMessages` (`$smart` fuzzy text); the raw
`messages` and `metadata` are stored **unindexed**.

```ts
import { createChatHistory } from "@upstash/agentkit-eve";

const history = createChatHistory({
  redis, // optional: Upstash Redis client (defaults to Redis.fromEnv())
  namespace: "agentkit:chat", // optional: key prefix + index name base (defaults to "agentkit:chat")
  ttlSeconds: 60 * 60 * 24 * 30, // optional: per-chat TTL in seconds (default: no expiry)
});
```

Persist on finish (from an eve hook): `saveChat` overwrites the **whole** message array, and you stash
eve's live `session` cursor in `metadata.session` so you can resume within eve's retention window.

```ts
// when a turn settles (e.g. an eve hook, or a route the client posts the snapshot to):
await history.saveChat(userId, chatId, snapshot.data.messages, {
  title, // optional: human-readable title
  metadata: { session: snapshot.session }, // optional: the live-resume cursor (kept unindexed)
});
```

Resume by handing the stored cursor to `useEveAgent({ initialSession })`, and render the transcript
from `getChat`. Use `listChats` / `searchChats` for a sidebar:

```ts
const chat = await history.getChat(userId, chatId); // chat.messages + chat.metadata.session
const chats = await history.listChats(userId, { limit: 50 }); // sidebar: summaries, no messages
const hits = await history.searchChats(userId, "headphones", { target: "both", limit: 20, minScore: 0 });

// client — resume the live session from the stored cursor
// const agent = useEveAgent({ initialSession: chat?.metadata?.session });
```

Other methods: `createChat(userId, { sessionId?, title?, messages?, metadata? })`,
`setTitle(userId, sessionId, title)`, `deleteChat(userId, sessionId)`.

## Memory tools (`agent/tools/*.ts`)

`defineMemoryRecallTool` and `defineMemorySaveTool` are ready eve tools — they call `defineTool`
internally, so you export them directly (no extra wrapping). One file each, one import. Pass a
`namespace` (a string shared across users, or a function deriving it from the context); `redis`
defaults to env. Memories are stored at `agentkit:memory:<namespace>:<id>`.

```ts
// agent/tools/recall_memory.ts
import { defineMemoryRecallTool } from "@upstash/agentkit-eve";

export default defineMemoryRecallTool({
  namespace: (_, ctx) => ctx.session.id, // the memory scope — a string, or (input, ctx) => string
  redis, // optional: Upstash Redis client (defaults to Redis.fromEnv())
  topK: 5, // optional: max memories to return
  minScore: 0, // optional: BM25 relevance floor for recall
});
```

```ts
// agent/tools/save_memory.ts
import { defineMemorySaveTool } from "@upstash/agentkit-eve";

export default defineMemorySaveTool({
  namespace: (_, ctx) => ctx.session.id, // the memory scope — a string, or (input, ctx) => string
  redis, // optional: Upstash Redis client (defaults to Redis.fromEnv())
});
```

## Search tools (`agent/lib/` + `agent/tools/*.ts`)

`defineSearchTools` builds `search` / `aggregate` / `count` eve tools over an Upstash Redis Search
index — the eve counterpart to the ai-sdk adapter's `createSearchTools`. The tool descriptions are
generated from your `s.object(...)` schema (fields, types, applicable filter operators), and the index
is created **reactively** on first use. Each returned tool is already `defineTool`-branded.

eve is file-centric (filename = tool name), so build the set **once** in `agent/lib/` and re-export
each tool from its own `agent/tools/<name>.ts` file:

```ts
// agent/lib/book-search.ts
import { s } from "@upstash/redis";
import { defineSearchTools } from "@upstash/agentkit-eve";
import { redis } from "../redis";

export const bookSearch = defineSearchTools({
  schema: s.object({ title: s.string(), author: s.string().noTokenize(), year: s.number() }), // the Upstash Redis Search schema (built with `s`)
  redis, // optional: Upstash Redis client (defaults to Redis.fromEnv())
  name: "books", // optional: index name (defaults to "agentkit:search")
  prefix: "books:", // optional: key prefix for indexed JSON docs (defaults to "<name>:")
  defaultLimit: 10, // optional: default page size for the `search` tool (defaults to 10)
});
```

```ts
// agent/tools/search_books.ts
import { bookSearch } from "../lib/book-search";
export default bookSearch.search; // and: aggregate_books.ts → bookSearch.aggregate, count_books.ts → bookSearch.count
```

## Rate limiting (`agent/channels/eve.ts`)

Eve gates inbound HTTP routes with an ordered [auth walk](https://eve.dev/docs/guides/auth-and-route-protection):
each `AuthFn` accepts (returns a `SessionAuthContext`), skips (returns `null`/`undefined`), or rejects
(throws). `createRateLimitAuth` returns a ready `AuthFn` — drop it into the walk ahead of your real
authenticators. It's a _gate_: it throttles, then returns `null` to fall through (over the limit it
throws a 403). Backed by [Upstash Ratelimit](https://github.com/upstash/ratelimit-js); keys are
`agentkit:rateLimit:<identifier>`.

```ts
// agent/channels/eve.ts
import { Ratelimit } from "@upstash/ratelimit";
import { createRateLimitAuth } from "@upstash/agentkit-eve";
import { localDev, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import { redis } from "../redis";

export default eveChannel({
  auth: [
    createRateLimitAuth({
      redis, // the Upstash Redis client backing the limiter
      limit: 20, // optional: requests allowed per window (default: 10)
      window: "1 m", // optional: sliding-window duration, e.g. "10 s" / "1 m" (default: "60 s")
      namespace: "agentkit:rateLimit", // optional: key prefix string; keys are `<namespace>:<identifier>`
      identifier: "global", // optional: who to limit — a string, or (request) => string (default: "global")
      message: "Rate limit exceeded.", // optional: message in the 403 body when over the limit
      limiter: Ratelimit.fixedWindow(20, "1 m"), // optional: a custom limiter overriding limit/window
    }),
    localDev(), // throttle first, then authenticate
    vercelOidc(),
  ],
});
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
or a function of the input + context). It calls `defineTool` internally, so you export it directly.
`redis` defaults to env. Keys are `agentkit:toolCache:<namespace>:<hash>`.

```ts
// agent/tools/get_weather.ts
import { z } from "zod";
import { defineCachedTool } from "@upstash/agentkit-eve";

export default defineCachedTool({
  description: "Get the current weather for a city.", // (defineTool field) shown to the model
  inputSchema: z.object({ city: z.string() }), // (defineTool field) zod schema for the input
  execute: async ({ city }) => fetchWeather(city), // (defineTool field) memoized
  namespace: "get_weather", // the cache key — a string, or (input, ctx) => string
  redis, // optional: Upstash Redis client (defaults to Redis.fromEnv())
  ttlSeconds: 600, // optional: per-result TTL in seconds (default: no expiry)
});
```

## Testing

Tests run against a **real Upstash Redis** (and a real Box when `UPSTASH_BOX_API_KEY` is set); only
LLM calls are mocked. Set `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (suites skip when
absent).

## License

MIT
