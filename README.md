# Redis AgentKit

A toolkit for building production AI agents entirely on [Upstash Redis](https://upstash.com/). It
gives you the stateful primitives agents need — memory, conversation history, caching, and RAG —
plus thin adapters for the popular agent frameworks. The "semantic" features
are powered by [Upstash Redis Search](https://upstash.com/docs/redis/search/introduction) and its
`$smart` fuzzy operator, so no separate vector database is required.

## Packages

| Package | Description |
| --- | --- |
| [`@upstash/agentkit-sdk`](./packages/sdk) | Core, framework-agnostic primitives. |
| [`@upstash/agentkit-ai-sdk`](./packages/ai-sdk) | Adapter for the [Vercel AI SDK](https://ai-sdk.dev). |
| [`@upstash/agentkit-eve`](./packages/eve) | Adapter for the Vercel Eve framework. |

## Core features

- **Agent memory** — long-term, fuzzily-recalled memories scoped per agent/user.
- **Semantic cache** — reuse LLM responses for fuzzily similar prompts (`$smart`); shipped as an AI
  SDK model middleware (`semanticCachedModel`).
- **Rate limiting** — an AI SDK model middleware backed by Upstash Ratelimit (`rateLimitedModel`).
- **Tool-call cache** — memoize deterministic tool results keyed by arguments.
- **Memory & search tools** — drop-in `recall`/`save` and schema-driven `search`/`aggregate`/`count`
  tools for `generateText`.
- **RAG** — chunking, indexing, and retrieval helpers over Upstash Redis Search.
- **Code sandbox** — a drop-in [Upstash Box](https://github.com/upstash/box) backend for Eve's
  `defineSandbox`.

## Examples

Runnable Next.js demos (real Upstash Redis + a mock/real model) live in [`examples/`](./examples):
[`ai-sdk-demo`](./examples/ai-sdk-demo) and [`eve-demo`](./examples/eve-demo).

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
