# Redis AgentKit

A toolkit for building production AI agents on top of [Upstash Redis](https://upstash.com/) and
[Upstash Vector](https://upstash.com/vector). It gives you the stateful primitives agents need —
memory, conversation history, caching, telemetry, a tool sandbox, and RAG — plus thin adapters for
the popular agent frameworks.

## Packages

| Package | Description |
| --- | --- |
| [`@upstash/agentkit-sdk`](./packages/sdk) | Core, framework-agnostic primitives. |
| [`@upstash/agentkit-ai-sdk`](./packages/ai-sdk) | Adapter for the [Vercel AI SDK](https://sdk.vercel.ai). |
| [`@upstash/agentkit-tanstack-ai`](./packages/tanstack-ai) | Adapter for TanStack AI. |
| [`@upstash/agentkit-langchain`](./packages/langchain) | Adapter for [LangChain.js](https://js.langchain.com). |
| [`@upstash/agentkit-eve`](./packages/eve) | Adapter for the Vercel Eve framework. |

## Core features

- **Agent memory** — long-term, semantically-recalled memories scoped per agent/user.
- **Chat history** — windowed conversation history with token-aware trimming.
- **Semantic cache** — reuse LLM responses for semantically similar prompts.
- **Tool-call cache** — memoize deterministic tool results keyed by arguments.
- **Telemetry** — structured spans for runs, model calls, and tool invocations.
- **Sandbox** — an execution harness (AI SDK v7 style) wrapping tools with timeouts, retries, and error capture.
- **RAG** — chunking, embedding, indexing, and retrieval helpers.

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
pnpm version          # bump versions + changelogs
pnpm release          # build + publish
```

## License

MIT
