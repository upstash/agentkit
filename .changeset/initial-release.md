---
"@upstash/agentkit-sdk": minor
"@upstash/agentkit-ai-sdk": minor
"@upstash/agentkit-eve": minor
---

Initial release of Redis AgentKit.

- **@upstash/agentkit-sdk** — core primitives on Upstash Redis: agent memory, semantic cache, tool-call cache, and RAG, with search powered by Upstash Redis Search's `$smart` fuzzy operator (no vector database required).
- **@upstash/agentkit-ai-sdk** — Vercel AI SDK adapter: semantic-cache + rate-limit model middleware, tool-call caching, and memory / Redis-Search tools.
- **@upstash/agentkit-eve** — Vercel Eve adapter: cached tools, memory tools, model wrappers, and an Upstash Box code-execution sandbox backend.
