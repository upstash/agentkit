---
"@upstash/agentkit-eve": minor
"@upstash/agentkit-eve-extension": minor
---

Upgrade to eve 0.32 (repo now builds and tests against eve 0.32.0 / AI SDK 7.0.58).

`@upstash/agentkit-eve`:

- The Upstash Box sandbox backend implements eve ≥0.32's `SandboxBackendHandle.stop()` (authored
  `ctx.getSandbox().stop()`): pauses the box, keeps the session reattachable, and rejects on provider
  errors per the contract (`shutdown()` stays best-effort).
- New exported type `ResolvedToolDefinition<TInput, TOutput>`: eve ≥0.31 widened
  `ToolDefinition.execute`'s return type to include `AsyncIterable<TOutput>` (streaming output
  snapshots); all agentkit tool factories (`defineCachedTool`, `defineMemoryRecallTool`,
  `defineMemorySaveTool`, `defineSearchTools`) now return this narrowed type, so calling `execute`
  directly still resolves to a plain `Promise`.
- `defineCachedTool` handles streaming executors: an async-generator `execute` is drained and only its
  final snapshot is cached and returned (a cache hit cannot replay intermediate snapshots).

`@upstash/agentkit-eve-extension`:

- The prebuilt `dist/extension` is now built with eve 0.32, so its compatibility manifest requires
  eve 0.32's contribution formats — **consumers need eve ≥0.32** to mount this version of the
  extension. (The eve ≥0.25.3 fix for extensions installed as physical `node_modules` directories
  means the old pnpm-only caveat is gone.)
