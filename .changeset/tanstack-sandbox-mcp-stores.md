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
  - `upstashMcpSessionStore()` is the `McpSessionStore` for MCP Apps.
    - The JSON part of each server descriptor is stored in Redis. Transport headers and env can be encrypted.
    - Functions such as `needsApproval` come back through your `resolve` callback.
    - It fails closed: it returns `null` rather than a descriptor that lost its approval gate.
- `upstashPersistence({ bucket })` is now typed with a required `blobs` store, so you can pass it straight to `createSandboxSnapshots()`.
