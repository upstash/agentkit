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

## End-to-end eval (no model provider)

The demo doubles as the extension's e2e smoke test, written as an
[eve eval](https://eve.dev/docs/evals) in [`evals/agentkit-smoke.eval.ts`](./evals/agentkit-smoke.eval.ts):

```bash
rm -rf .eve                          # clear stale local dev state after an eve upgrade
AGENTKIT_MOCK_MODEL=1 npx eve eval   # exit 0 = pass, ~1s
```

`AGENTKIT_MOCK_MODEL=1` switches [`agent/agent.ts`](./agent/agent.ts) to a deterministic
`mockModel` (from `eve/evals`) whose scripted response calls `agentkit__save_memory` and then
echoes the tool result — so no `OPENAI_API_KEY` is needed and no provider is called, but the
extension's real tool executes against real Redis (only the `UPSTASH_REDIS_REST_*` vars are
required). A green run proves the built extension loads on the installed eve, its contributions
mount, a session runs end to end, the tool call writes `agentkit:memory:demo-user:*`, and the
`chat_history` hook captures the turn to `agentkit:chat:demo-user:<sessionId>`.

Two notes if you touch the fixture: the mocked branch sets `modelContextWindowTokens` because the
mock model has no AI Gateway metadata (without it, `eve eval` fails compiling compaction), and it
uses `mockModel`'s plain-callback form — a custom `{ modelId, provider }` identity hits the same
compaction error.
