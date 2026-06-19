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
| [`@upstash/agentkit-ai-sdk`](./packages/ai-sdk) | Adapter for the [Vercel AI SDK](https://sdk.vercel.ai). |
| [`@upstash/agentkit-tanstack-ai`](./packages/tanstack-ai) | Adapter for TanStack AI. |
| [`@upstash/agentkit-langchain`](./packages/langchain) | Adapter for [LangChain.js](https://js.langchain.com). |
| [`@upstash/agentkit-eve`](./packages/eve) | Adapter for the Vercel Eve framework. |

## Core features

- **Agent memory** — long-term, fuzzily-recalled memories scoped per agent/user.
- **Semantic cache** — reuse LLM responses for fuzzily similar prompts (`$smart`).
- **Tool-call cache** — memoize deterministic tool results keyed by arguments.
- **RAG** — chunking, indexing, and retrieval helpers over Upstash Redis Search.
- **Code sandbox** — a drop-in [Upstash Box](https://github.com/upstash/box) backend for Eve's
  `defineSandbox` (and an AI SDK v7 harness provider). Lives in the adapter packages.

## Development

```bash
pnpm install
pnpm build      # build all packages
pnpm test       # run all tests (LLM calls are mocked)
pnpm lint       # eslint + prettier
pnpm typecheck  # tsc across packages
```

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
