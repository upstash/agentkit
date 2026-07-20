# Redis AgentKit

A toolkit for building production AI agents entirely on [Upstash Redis](https://upstash.com/). It
gives you the stateful primitives agents need — memory, conversation history, search, and caching —
plus thin adapters for the popular agent frameworks. The "semantic" features
are powered by [Upstash Redis Search](https://upstash.com/docs/redis/search/introduction) and its
`$smart` fuzzy operator, so no separate vector database is required.

## Packages

| Package | Description |
| --- | --- |
| [`@upstash/agentkit-sdk`](./packages/sdk) | Core, framework-agnostic primitives. |
| [`@upstash/agentkit-ai-sdk`](./packages/ai-sdk) | Adapter for the [Vercel AI SDK](https://ai-sdk.dev). |
| [`@upstash/agentkit-eve`](./packages/eve) | Adapter for the Vercel Eve framework. |
| [`@upstash/agentkit-eve-extension`](./packages/eve-extension) | The same capabilities as a mountable [Eve extension](https://eve.dev/docs/extensions) — one file in `agent/extensions/` adds memory tools, search tools, and durable chat-history capture. |

## Core features

- **Chat history** — durable, Redis-Search-backed conversation transcripts (`ChatHistory`): save the
  whole message array per chat, list a user's chats for a sidebar, and fuzzily `$smart`-search what the
  user or model said.
- **Agent memory** — long-term, fuzzily-recalled memories scoped per agent/user, plus drop-in
  `recall`/`save` tools for `generateText`.
- **Search tools** — schema-driven `search`/`aggregate`/`count` tools over Upstash Redis Search; the
  index is created reactively on first use. Use these over your own documents for RAG-style retrieval.
- **Rate limiting** — a configured Upstash Ratelimit factory (`createRateLimit`) you call before the model.
- **Code sandbox** (Eve only) — a drop-in [Upstash Box](https://github.com/upstash/box) backend for
  Eve's `defineSandbox`.
- **Tool-call cache** — memoize deterministic tool results keyed by arguments.

## Examples

Runnable demos (real Upstash Redis + a mock/real model) live in [`examples/`](./examples):
[`ai-sdk-demo`](./examples/ai-sdk-demo), [`eve-demo`](./examples/eve-demo), and
[`eve-extension-demo`](./examples/eve-extension-demo) (an eve agent that mounts
`@upstash/agentkit-eve-extension`).

## Development

```bash
pnpm install
pnpm build      # build all packages
pnpm test       # run all tests (against a real Upstash Redis; LLM calls mocked unless OPENAI_API_KEY is set)
pnpm lint       # eslint + prettier
pnpm typecheck  # tsc across packages
```

Tests need `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (in a repo-root `.env`); suites that
hit Redis skip themselves when absent. Some tests use `UPSTASH_BOX_API_KEY` and `OPENAI_API_KEY`.

## Releasing

This repo uses [Changesets](https://github.com/changesets/changesets).

```bash
pnpm changeset        # describe a change
pnpm ci:version       # bump versions + changelogs
pnpm ci:publish       # publish to npm

# (`version`/`release` script names are avoided — they collide with pnpm's built-in commands.)
```

## License

MIT
