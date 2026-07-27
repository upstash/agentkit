# @upstash/agentkit-eve-extension

[Upstash AgentKit](https://upstash.com/) as an [**Eve extension**](https://eve.dev/docs/extensions):
one file in `agent/extensions/` mounts long-term memory tools, Redis Search tools, and durable
chat-history capture — all on **Upstash Redis**, all under one namespace. No per-tool files, no
repeated schemas; upgrades come through the package manager.

| Contribution | What composes |
| --- | --- |
| `<ns>__recall_memory` / `<ns>__save_memory` | Long-term memory tools the model reads and writes. |
| `<ns>__search` / `<ns>__search_aggregate` / `<ns>__search_count` | Tools over a Redis Search index (this is how you do RAG). Present only when `search` is configured. |
| `<ns>__chat_history` (hook) | Persists every user/assistant message to Redis `ChatHistory` — a durable, `$smart`-searchable transcript store. Write-side only: no tool reads it back, you query it from your own code (or [wire it into `search`](#letting-the-agent-search-its-own-chat-history)). Off by default; enable with `chatHistory: true`. |
| Instructions fragment | A short always-on rule teaching the model when to save/recall memories. |

`<ns>` is the mount file's basename — the examples below use `agentkit`.

Start from an eve project (eve ≥ 0.25.2), then:

```bash
pnpm add @upstash/agentkit-eve-extension
```

Set `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` in your env (the extension defaults to
`Redis.fromEnv()`).

## Mount it

Every field is optional. The smallest mount gives the agent memory tools:

```ts
// agent/extensions/agentkit.ts
import agentkit from "@upstash/agentkit-eve-extension";

export default agentkit();
```

Add `search` to turn on the search tools over one index. The schema is built with `s` from
`@upstash/redis` — your mount file imports it, so add the package to your app
(`pnpm add @upstash/redis`):

```ts
// agent/extensions/agentkit.ts
import { s } from "@upstash/redis";
import agentkit from "@upstash/agentkit-eve-extension";

export default agentkit({
  search: {
    schema: s.object({ title: s.string(), author: s.string().noTokenize(), year: s.number() }),
    indexName: "books",
  },
});
```

That's it — the tools appear to the model as `agentkit__recall_memory`, `agentkit__search`, …, and a
short memory instruction is added to your system prompt.

### Options

| Field | Default | |
| --- | --- | --- |
| `userId` | principal → session id | The tenant boundary for memory + chat history. A string (one shared scope), or `(ctx) => string` to derive it per call. |
| `search` | _off_ | `{ schema, indexName?, prefix?, defaultLimit? }`. Omit it and the search tools don't exist. |
| `memory` | — | `{ topK?, minScore? }` to tune recall. |
| `chatHistory` | `false` | `true` to capture transcripts, or `{ prefix?, indexName?, ttlSeconds? }` to tune where they're stored. |
| `redis` | `Redis.fromEnv()` | An explicit Upstash Redis client. |

## What lands in Redis

- `agentkit:memory:<userId>:<id>` — memories (searchable via the `agentkit:memory` index).
- `agentkit:chat:<userId>:<sessionId>` — one JSON doc per session (only when `chatHistory` is
  enabled): the raw transcript plus `$smart`-indexed user/model text. Read it back with `ChatHistory`
  from `@upstash/agentkit-sdk` (`listChats` / `searchChats` / `getChat`).
- Your `search` index documents are whatever you seed under `<prefix>` (`redis.json.set`).

`userId` and `sessionId` are Redis key parts, so `:` in derived values is replaced with `_`.

Memory, `search`, and `chatHistory` are three independent features: memory is what the model chooses
to remember, `search` is RAG over documents **you** seed, and `chatHistory` is a transcript log. They
don't read each other.

## Letting the agent search its own chat history

Captured chats are indexed Redis Search documents like any other, so you can aim `search` at them and
the model gets a tool that queries past conversations. Mirror `ChatHistory`'s internal schema and
point `indexName`/`prefix` at its keyspace:

```ts
// agent/extensions/agentkit.ts
import { s } from "@upstash/redis";
import agentkit from "@upstash/agentkit-eve-extension";

export default agentkit({
  userId: "demo-user",
  chatHistory: true,
  search: {
    // `ChatHistory`'s defaults: keys `agentkit:chat:<userId>:<sessionId>`, index `agentkit_chat`
    // (the prefix, made identifier-safe). Set both here if you tuned `chatHistory.prefix`.
    indexName: "agentkit_chat",
    prefix: "agentkit:chat:",
    schema: s.object({
      userId: s.string().noTokenize(),
      sessionId: s.string().noTokenize(),
      userMessages: s.string(),
      modelMessages: s.string(),
    }),
  },
});
```

The model can then run `agentkit__search` with e.g.
`{ "userMessages": { "$smart": "redis pipelining" } }` to find the session where that came up.

**This is single-tenant only.** The `search` tools take the filter **from the model**, and nothing
forces a `userId` clause onto it — so the tool can read *every* user's transcripts, not just the
current one. That's the difference from `ChatHistory.searchChats({ userId, query })`, which pins
`userId` server-side. Only wire this up when one user owns the whole Redis (a local or single-user
agent); for a multi-tenant app, query `ChatHistory` from your own code instead and hand the result to
the model yourself.

Three more things to know before you reach for it:

- You have **one `search` slot per mount**, so this spends it — no RAG over your own documents in the
  same mount.
- Hits are **whole chats, not messages**: `userMessages`/`modelMessages` are one merged blob per
  session, and a result carries the full stored document, including the raw transcript. Keep `limit`
  low or you'll flood the context window.
- `search_aggregate` doesn't work over this index — `$terms` needs a FAST field, and these are text.
  Disable that slot (`disableTool()`) if you don't want the model trying it.

## The search tools are dynamic

Their descriptions and input schemas are generated from your `search.schema` (field-by-field filter
guidance for the model), which is only known once the mount config binds at runtime. So they're
contributed as [dynamic tools](https://eve.dev/docs/guides/dynamic-capabilities) resolved at
`session.started` — and when `search` isn't configured they resolve to nothing instead of erroring.

## Overriding or disabling contributions

Mount as a directory to override per slot ([docs](https://eve.dev/docs/extensions#overrides)):

```
agent/extensions/agentkit/
  extension.ts          # the mount: export default agentkit({ ... })
  tools/save_memory.ts  # your override for agentkit__save_memory
```

Drop a tool you don't want:

```ts
// agent/extensions/agentkit/tools/save_memory.ts
import { disableTool } from "eve/tools";

export default disableTool();
```

Or re-define one — e.g. gate saves behind approval:

```ts
// agent/extensions/agentkit/tools/save_memory.ts
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { save_memory } from "@upstash/agentkit-eve-extension/tools";

export default defineTool({ ...save_memory, approval: always() });
```

The static memory tools can also be narrowed in your hooks with `toolResultFrom` (import them from
`@upstash/agentkit-eve-extension/tools`). The search tools are dynamic resolvers, so they aren't
importable as static definitions.

## When to use this vs `@upstash/agentkit-eve`

Use the extension when you want the batteries-included bundle under one mount. Use
[`@upstash/agentkit-eve`](../eve) when you need the pieces the extension can't carry — the Upstash
Box **sandbox backend** and the **rate-limit channel auth** (extensions can't contribute sandbox or
channel config) — or its `defineCachedTool` wrapper for your own tools. The two compose fine in one
agent.

## Example

[`examples/eve-extension-demo`](../../examples/eve-extension-demo) is a scaffolded eve agent with the
extension mounted: memory + book search + chat capture, end to end.
