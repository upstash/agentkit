# @upstash/agentkit-eve-extension

## 0.9.0

### Minor Changes

- 35e3d69: fix!: rebuild against eve 0.49.0 and raise the `eve` peer floor to `>=0.48.0`

  No source changed. The extension's `dist` is rebuilt with eve 0.49.0, which re-stamps the manifest's
  tool contract 21 → 24 (every other contribution contract is unchanged). eve 0.48.0 is the first
  release accepting tool 24, so the `eve` peer moves `">=0.47.0"` → `">=0.48.0"`.

  No 0.47.x works, including 0.47.7 — the tool contract moved twice in three releases (22 → 23 in
  0.47.7, 23 → 24 in 0.48.0). On an unsupported eve the mount contributes nothing and `eve build`
  fails with `Selected module binding "extensions/agentkit.ts" has no compile or runtime usage.`

  This supersedes the unreleased 0.47.6 rebuild (tool 22, floor `>=0.47.5`), which never shipped.

### Patch Changes

- Updated dependencies [0117c2e]
  - @upstash/agentkit-sdk@0.9.0

## 0.8.0

### Minor Changes

- f426c7d: fix!: rebuild against eve 0.47.3 and raise the `eve` peer floor to `>=0.47.0`

  The extension is now built with **eve 0.47.3**, whose
  `dist/extension/_manifest.json` stamps formatVersion 2 and contracts
  extension 1 / **tool 21** / **dynamicTool 21** / **hook 16** / instructions 2 /
  config 1 — up from tool 17 / dynamicTool 18 / hook 14 in the published
  `0.7.0` build (eve 0.44.3). This supersedes the unreleased intermediate rebuilds
  on eve 0.45.0/0.45.2 (tool 18/19), which never shipped.

  eve 0.47.0 is the first release whose `EXTENSION_CAPABILITY_CONTRACTS` accept
  those contracts (0.46.1 tops out at tool 20 / hook 15; 0.45.1–0.46.0 at tool 19 /
  hook 14; 0.45.0 at tool 18; 0.43.0–0.44.4 at tool 17), so the `eve` peer moves
  from `">=0.43.0"` to `">=0.47.0"`. Verified by mounting the rebuilt extension in
  a real eve app: it builds on eve 0.47.0 and fails on 0.46.1. Contribution
  contracts move in _patch_ releases, so always re-derive the floor from the freshly
  built manifest.

  No extension source changed; all packages build, typecheck, lint and pass their
  tests against eve 0.47.3.

## 0.7.0

### Minor Changes

- 55db7e1: feat!: rebuild against eve 0.44 so the extension loads on current eve (fixes #22)

  `@upstash/agentkit-eve-extension@0.6.0` was built with eve 0.32.0, stamping hook
  contract v9 in its `dist/extension/_manifest.json` — a contract eve 0.33.0
  dropped, so the extension failed `eve build` on every eve released after 0.32.0.

  - The extension is now built with **eve 0.44.3** (manifest: formatVersion 2,
    tool 17 / dynamicTool 18 / hook 14 / instructions 2) and loads on
    **eve ≥ 0.43.0**.
  - The extension's `eve` peer dependency is tightened from `"*"` to
    `">=0.43.0"`, so an incompatible eve now fails at install time with an
    actionable message instead of at `eve build`.
  - `@upstash/agentkit-eve`'s `eve` peer is corrected from `>=0.24.0` to
    `>=0.32.0` — the Upstash Box sandbox backend implements the `stop()` handle
    contract eve requires since 0.32.

  No runtime behavior changed; all sources compile and pass unmodified against
  eve 0.44.3.

## 0.6.0

### Minor Changes

- 5c93af5: feat: report the sdk name + version to Upstash via the redis client's telemetry headers

  Every feature that takes a `redis` client now appends its package tag to the client's
  `Upstash-Telemetry-Sdk` header (e.g.
  `@upstash/redis@1.38.0,@upstash/agentkit-sdk@0.2.0,@upstash/agentkit-ai-sdk@0.2.0`), matching
  `@upstash/ratelimit`. No personal data, keys or identifiers are collected. Opt out with
  `enableTelemetry: false` on any config, with the same option on the redis client, or with the
  `UPSTASH_DISABLE_TELEMETRY` env var.

### Patch Changes

- Updated dependencies [5c93af5]
  - @upstash/agentkit-sdk@0.6.0

## 0.5.0

### Minor Changes

- b0ef882: Upgrade to eve 0.32 (repo now builds and tests against eve 0.32.0 / AI SDK 7.0.58).

  `@upstash/agentkit-eve`:

  - The Upstash Box sandbox backend implements eve ≥0.32's `SandboxBackendHandle.stop()` (authored
    `ctx.getSandbox().stop()`): pauses the box, keeps the session reattachable, and rejects on provider
    errors per the contract (`shutdown()` stays best-effort).
  - `defineCachedTool` does not cache streams: eve ≥0.31 lets tool executors be async generators
    (streaming preliminary output snapshots), but a cache hit could never replay them —
    `DefineCachedToolConfig` now rejects async-generator executors at the type level (its `execute`
    must resolve to a value), and a runtime `TypeError` backstops untyped JS callers before the
    generator object would be serialized into the cache.

  `@upstash/agentkit-eve-extension`:

  - The prebuilt `dist/extension` is now built with eve 0.32, so its compatibility manifest requires
    eve 0.32's contribution formats — **consumers need eve ≥0.32** to mount this version of the
    extension. (The eve ≥0.25.3 fix for extensions installed as physical `node_modules` directories
    means the old pnpm-only caveat is gone.)

## 0.4.0

### Minor Changes

- 399b20c: Add `search_chat_history` and `read_chat_history` tools, contributed whenever `chatHistory` is enabled

  Captured transcripts were write-only from the agent's side: the hook persisted every message to
  Upstash Redis, but nothing read them back, so recalling an earlier conversation wasn't possible
  without querying `ChatHistory` from your own code.

  `chatHistory: true` now also contributes two tools over the same store:

  - `<ns>__search_chat_history` — `{ query, target?, limit? }`, a typo-tolerant (`$smart`) search over
    what was said, returning matching chats as summaries (`sessionId`, `title`, `updatedAt`,
    `messageCount`, `score`). The current session is excluded — its text is already in context.
  - `<ns>__read_chat_history` — `{ sessionId, limit? }`, reads one of those chats back (newest messages
    last, capped at 50 per call with a `truncated` flag).

  Both pin `userId` from the session rather than model input, so a chat lookup can only reach the
  current user's own transcripts. They're dedicated tools rather than something you point the generic
  `search` tool at, which means your `search` slot stays free for RAG over your own data. Like the
  search tools they're dynamic, so they don't exist at all when `chatHistory` is off; drop them with
  `disableTool()` if you want capture without model-facing reads.

  The instructions fragment gains a short rule telling the model to look back at past conversations
  when the user refers to one.

## 0.3.1

### Patch Changes

- c198499: Rebuild on eve ≥0.25's dist packaging format (`eve.extension.source`/`.dist`, prebuilt `dist/extension` + compatibility manifest, dist-only tarball). Fixes installing the extension from npm: eve 0.25 rejects the old source-recompile format outright, and the prebuilt dist also removes the need to install `@upstash/agentkit-sdk` alongside the extension. Consumers need eve ≥0.25.2; apps that configure `search` also declare `@upstash/redis` themselves (their own mount file imports the `s` schema builder from it — a mount without `search` needs no extra installs).

## 0.3.0

### Minor Changes

- 463c788: Add `@upstash/agentkit-eve-extension`: AgentKit as a mountable eve extension (eve ≥0.24). One file in `agent/extensions/` composes memory tools, schema-aware Redis Search tools, an opt-in durable chat-history hook, and a memory instructions fragment under one namespace.

  `@upstash/agentkit-eve` moves to **eve 0.24.6** and **ai 7.0.30** (stable). Breaking: eve ≥0.24 replaced the sandbox backend handle's `dispose()` with `shutdown()` (fires only on server shutdown; the Upstash Box backend now pauses the box), and the `eve` peer range is now `>=0.24.0`.
