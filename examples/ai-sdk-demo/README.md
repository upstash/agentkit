# ai-sdk-demo

A persistent, streaming chat app built on [`@upstash/agentkit-ai-sdk`](../../packages/ai-sdk) and the
[Vercel AI SDK](https://ai-sdk.dev) (`useChat`), backed entirely by a real Upstash Redis.

## What it shows

- **Chat history** — every turn is persisted with `createChatHistory`. The sidebar lists your chats and
  fuzzy-searches them (`listChats` / `searchChats`); reloading or revisiting a chat resumes it
  (`getChat` → `useChat({ messages })`). The route persists the whole conversation in `onFinish`.
- **Agent memory** — `recall_memory` / `save_memory` tools (`createMemoryTools`).
- **Search tools** — schema-driven `search` / `aggregate` / `count` over a seeded **books** index
  (`createSearchTools`). The books are seeded once into Redis on first load.
- **Tool cache** — a memoized `convert_price` tool (`cachedTools`).
- **Rate limiting** — `createRateLimit` checked (by user) before each model call.

Tool calls are rendered inline in the chat so you can see what the agent did.

## Setup

```bash
cp .env.example .env   # then fill in the values (or put them in the repo-root .env)
pnpm install           # from the repo root
```

`.env.example` lists the required vars: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, and
`OPENAI_API_KEY`. The app reads a local `.env` first, then falls back to the repo-root `.env`.

## Run

```bash
pnpm --filter ai-sdk-demo dev   # or: cd examples/ai-sdk-demo && pnpm dev
```

Open <http://localhost:3000>. The demo uses the `gpt-5.4-mini` model.
