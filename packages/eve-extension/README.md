# @upstash/agentkit-eve-extension

[Upstash AgentKit](https://upstash.com/) as an [**Eve extension**](https://eve.dev/docs/extensions):
one file in `agent/extensions/` mounts long-term memory tools, Redis Search tools, and durable
chat-history capture — all on **Upstash Redis**, all under one namespace. No per-tool files, no
repeated schemas; upgrades come through the package manager.

| Contribution | What composes |
| --- | --- |
| `<ns>__recall_memory` / `<ns>__save_memory` | Long-term memory tools the model reads and writes. |
| `<ns>__search` / `<ns>__search_aggregate` / `<ns>__search_count` | Tools over a Redis Search index (this is how you do RAG). Present only when `search` is configured. |
| `<ns>__chat_history` (hook) | Persists every user/assistant message to Redis `ChatHistory` — a durable, `$smart`-searchable transcript store. On by default. |
| Instructions fragment | A short always-on rule teaching the model when to save/recall memories. |

`<ns>` is the mount file's basename — the examples below use `agentkit`.

Start from an eve project (eve ≥ 0.24), then:

```bash
pnpm add @upstash/agentkit-eve-extension
```

Set `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` in your env (the extension defaults to
`Redis.fromEnv()`).

## Mount it

```ts
// agent/extensions/agentkit.ts
import { s } from "@upstash/redis";
import agentkit from "@upstash/agentkit-eve-extension";

export default agentkit({
  // optional: the tenant boundary for memory + chat history. A string shares one scope
  // (single-user agents); a function derives it per call from eve's SessionContext.
  // Default: auth.current?.principalId ?? auth.initiator?.principalId ?? session.id.
  userId: (ctx) => ctx.session.auth.current?.principalId ?? ctx.session.id,

  // optional: enables the search / search_aggregate / search_count tools over one index.
  // Omit it and those tools simply don't exist.
  search: {
    schema: s.object({ title: s.string(), author: s.string().noTokenize(), year: s.number() }),
    indexName: "books", // optional: defaults to "agentkit:search"
    // prefix: "books:",       // optional: key prefix for indexed docs, defaults to "<indexName>:"
    // defaultLimit: 10,       // optional: default page size for `search`
  },

  // optional: tune the recall tool
  // memory: { topK: 5, minScore: 1 },

  // optional: chat-history capture is ON by default; pass `false` to turn it off,
  // or an object to tune it: { prefix: "agentkit:chat", indexName: "...", ttlSeconds: 60 * 60 * 24 * 30 }
  // chatHistory: false,

  // optional: an explicit Redis client; defaults to Redis.fromEnv()
  // redis: new Redis({ url: "...", token: "..." }),
});
```

That's it. The tools appear to the model as `agentkit__recall_memory`, `agentkit__search`, …, the
hook records transcripts, and the instructions fragment is appended to your system prompt.

## What lands in Redis

- `agentkit:memory:<userId>:<id>` — memories (searchable via the `agentkit:memory` index).
- `agentkit:chat:<userId>:<sessionId>` — one JSON doc per session: the raw transcript plus
  `$smart`-indexed user/model text. Eve's own workflow store is pruned days after a run completes;
  Redis is the durable source of truth. Read it back anywhere with `ChatHistory` from
  `@upstash/agentkit-sdk` (`listChats` / `searchChats` / `getChat`).
- Your `search` index documents are whatever you seed under `<prefix>` (`redis.json.set`).

`userId` and `sessionId` are Redis key parts, so `:` in derived values is replaced with `_`.

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
