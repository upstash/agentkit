---
"@upstash/agentkit-tanstack-ai": minor
---

Add stores for TanStack AI's sandbox and MCP packages, all on Upstash Redis.

- `@upstash/agentkit-tanstack-ai/sandbox` (needs `@tanstack/ai-sandbox` >= 1.0.0):
  - `upstashSandboxCheckpointStore()` is a `SandboxCheckpointStore` for portable sandbox snapshots. It supports `forkFromCheckpoint`, which branches a thread, files and transcript included.
  - `upstashSandboxInstanceStore()` lets any server resume a thread's sandbox.
  - Both pass TanStack's sandbox conformance suites.
- `@upstash/agentkit-tanstack-ai/mcp` (needs `@tanstack/ai-mcp` >= 1.0.0):
  - `upstashMcpTaskStore()` is the `taskStore` for `createMCPServer`.
  - `upstashMcpEventStore()` stores MCP Events webhook subscriptions, shared across instances.
- `upstashPersistence({ bucket })` is now typed with a required `blobs` store, so you can pass it straight to `createSandboxSnapshots()`.
