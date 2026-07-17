# eve-extension-demo

A minimal [eve](https://eve.dev) agent that mounts
[`@upstash/agentkit-eve-extension`](../../packages/eve-extension) — the whole integration is the one
file [`agent/extensions/agentkit.ts`](./agent/extensions/agentkit.ts). It gives the agent:

- long-term memory tools (`agentkit__recall_memory` / `agentkit__save_memory`),
- schema-aware Redis Search tools over the shared demo books index
  (`agentkit__search` / `agentkit__search_aggregate` / `agentkit__search_count`),
- durable chat-history capture into Upstash Redis (the `agentkit__chat_history` hook), and
- a memory instructions fragment merged into the system prompt.

## Run it

Create `.env` in this directory:

```
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
OPENAI_API_KEY=...
```

Then:

```bash
pnpm dev   # eve dev
```

Talk to it (the eve dev TUI, or curl):

```bash
curl -X POST http://127.0.0.1:3000/eve/v1/session \
  -H 'content-type: application/json' \
  -d '{"message":"My favorite author is Ursula K. Le Guin - remember that, then find her earliest book in the index."}'
```

The agent saves the fact to memory, `$smart`-searches the books index, and the whole transcript lands
at `agentkit:chat:demo-user:<sessionId>` in Redis. A follow-up session ("what author do I like?")
recalls the memory.

The books index (`eve-demo-books`) is shared with [`eve-demo`](../eve-demo), which seeds it — run that
demo once, or seed a few `eve-demo-books:*` JSON docs yourself.
