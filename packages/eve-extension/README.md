# @upstash/agentkit-eve-extension

[Upstash AgentKit](https://upstash.com/) as an [**Eve extension**](https://eve.dev/docs/extensions):
one file in `agent/extensions/` mounts long-term memory tools, Redis Search tools, and durable chat
history the agent can search — all on **Upstash Redis**, all under one namespace. No per-tool files,
no repeated schemas; upgrades come through the package manager.

| Contribution | What composes |
| --- | --- |
| `<ns>__recall_memory` / `<ns>__save_memory` | Long-term memory tools the model reads and writes. |
| `<ns>__search` / `<ns>__search_aggregate` / `<ns>__search_count` | Tools over a Redis Search index (this is how you do RAG). Present only when `search` is configured. |
| `<ns>__search_chat_history` / `<ns>__read_chat_history` | Tools to find and read the user's **past conversations**. Present only when `chatHistory` is enabled. |
| `<ns>__chat_history` (hook) | Persists every user/assistant message to Redis `ChatHistory` — the durable, `$smart`-searchable transcript store the two tools above read. Off by default; enable with `chatHistory: true`. |
| Instructions fragment | A short always-on rule teaching the model when to save/recall memories and when to look back at past conversations. |

`<ns>` is the mount file's basename — the examples below use `agentkit`.

Start from an eve project (eve ≥ 0.48.0 — the prebuilt extension is built with eve 0.49.0 and its compatibility manifest requires tool contract v24 (dynamicTool v21, hook v16), which eve 0.48.0 is the first release to support; the package declares this as its `eve` peer range), then:

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
| `chatHistory` | `false` | `true` to capture transcripts and add the two past-conversation tools, or `{ prefix?, indexName?, ttlSeconds? }` to also tune where chats are stored. |
| `redis` | `Redis.fromEnv()` | An explicit Upstash Redis client. |

## What lands in Redis

- `agentkit:memory:<userId>:<id>` — memories (searchable via the `agentkit:memory` index).
- `agentkit:chat:<userId>:<sessionId>` — one JSON doc per session (only when `chatHistory` is
  enabled): the raw transcript plus `$smart`-indexed user/model text. Read it back with `ChatHistory`
  from `@upstash/agentkit-sdk` (`listChats` / `searchChats` / `getChat`).
- Your `search` index documents are whatever you seed under `<prefix>` (`redis.json.set`).

`userId` and `sessionId` are Redis key parts, so `:` in derived values is replaced with `_`.

Memory, `search`, and `chatHistory` are three independent features: memory is what the model chooses
to remember, `search` is RAG over documents **you** seed, and `chatHistory` is the transcript of what
was actually said. They live in separate keyspaces and separate indexes.

## Past conversations

`chatHistory: true` does two things: the hook writes every message to Redis as the session streams,
and the model gets two tools over that store — so "what did we decide about the schema last week?"
works across sessions, not just within one.

```ts
// agent/extensions/agentkit.ts
import agentkit from "@upstash/agentkit-eve-extension";

export default agentkit({ chatHistory: true });
```

- **`<ns>__search_chat_history`** — `{ query, target?, limit? }`. Typo-tolerant (`$smart`) search over
  what was said, returning the matching chats as `{ sessionId, title, updatedAt, messageCount, score }`
  — summaries, not transcripts, so a wide search can't flood the context window. `target` narrows to
  `"user"` (what they said), `"model"` (what you replied), or `"both"` (default). The **current**
  conversation is excluded: it's already in context.
- **`<ns>__read_chat_history`** — `{ sessionId, limit? }`. Reads one of those chats back, newest
  messages last, capped at 50 per call with a `truncated` flag when there's more.

Both **pin `userId` from the session**, never from model input, so a chat search can only ever reach
the current user's own transcripts — one user's `sessionId` won't address another's chat. This is why
they're separate tools rather than something you point the generic `search` tool at: `search` takes
its filter from the model, so it couldn't enforce that boundary. Your `search` slot stays free for
RAG over your own data.

You can still reach the same store from your own code — `ChatHistory` from `@upstash/agentkit-sdk`
(`listChats` / `searchChats` / `getChat`) — for a history sidebar, evals, or analytics.

Don't want the model reading history at all? Keep the capture and
[disable the two tools](#overriding-or-disabling-contributions).

## The search and chat-history tools are dynamic

The search tools' descriptions and input schemas are generated from your `search.schema`
(field-by-field filter guidance for the model), and whether the chat-history tools apply at all
depends on `chatHistory` — neither is known until the mount config binds at runtime. So both sets are
contributed as [dynamic tools](https://eve.dev/docs/guides/dynamic-capabilities) resolved at
`session.started`: unconfigured, they resolve to nothing rather than erroring when the model calls
them. Only the memory tools are static.

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
[`@upstash/agentkit-eve`](../eve) when you need the pieces this extension doesn't ship — the Upstash
Box **sandbox backend** (an extension root can't declare a sandbox) and the **rate-limit channel
auth** (an `AuthFn` you drop into your own channel's `auth` walk) — or its `defineCachedTool` wrapper
for your own tools. The two compose fine in one agent.

## Telemetry

The SDK reports its name and version to Upstash as a header on the requests made by the redis client,
so we know which SDK versions are in use. No personal data, keys or identifiers are collected. The
header looks like `@upstash/redis@1.38.0,@upstash/agentkit-sdk@0.2.0,@upstash/agentkit-eve-extension@0.5.0`.

Opt out with `enableTelemetry: false` in the mount config:

```ts
export default agentkit({ enableTelemetry: false });
```

or by setting the `UPSTASH_DISABLE_TELEMETRY` environment variable. Disabling telemetry on the redis
client itself also disables it here.

## Example

[`examples/eve-extension-demo`](../../examples/eve-extension-demo) is a scaffolded eve agent with the
extension mounted: memory + book search + chat capture, end to end. It also carries the extension's
e2e smoke test — an eve eval driven by a deterministic `mockModel`, so it needs Redis credentials but
no model provider:

```bash
cd examples/eve-extension-demo
AGENTKIT_MOCK_MODEL=1 npx eve eval
```

See the demo's [README](../../examples/eve-extension-demo/README.md#end-to-end-eval-no-model-provider)
for what it covers and how the fixture works.
