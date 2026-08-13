---
"@upstash/agentkit-eve": minor
"@upstash/agentkit-eve-extension": minor
---

Upgrade to eve 0.32 (repo now builds and tests against eve 0.32.0 / AI SDK 7.0.58).

`@upstash/agentkit-eve`:

- The Upstash Box sandbox backend implements eve ≥0.32's `SandboxBackendHandle.stop()` (authored
  `ctx.getSandbox().stop()`): pauses the box, keeps the session reattachable, and rejects on provider
  errors per the contract (`shutdown()` stays best-effort).
- `defineCachedTool` does not cache streams: eve ≥0.31 lets tool executors be async generators
  (streaming preliminary output snapshots), but a cache hit could never replay them —
  `DefineCachedToolConfig` now rejects async-generator executors at the type level (its `execute`
  must resolve to a value).

`@upstash/agentkit-eve-extension`:

- The prebuilt `dist/extension` is now built with eve 0.32, so its compatibility manifest requires
  eve 0.32's contribution formats — **consumers need eve ≥0.32** to mount this version of the
  extension. (The eve ≥0.25.3 fix for extensions installed as physical `node_modules` directories
  means the old pnpm-only caveat is gone.)
