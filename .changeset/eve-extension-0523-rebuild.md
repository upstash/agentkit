---
"@upstash/agentkit-eve-extension": minor
---

fix: work on eve 0.63.0 — rebuild against it, raise the `eve` peer floor to `>=0.63.0`, and make the
schema-derived search tools replayable

**`0.10.0` is broken on `eve@latest`.** eve 0.63.0 (2026-09-19) dropped the `dynamicTool` 29 contract
that `0.10.0`'s manifest (built with eve 0.52.2) requires, so a fresh consumer installing `eve@latest` +
`@upstash/agentkit-eve-extension@latest` installs cleanly and then fails `eve build` with
`Selected module binding "extensions/agentkit.ts" has no compile or runtime usage.` — every one of the
extension's contributions is gone. eve 0.55.0 through 0.62.0 still accepted `0.10.0`; 0.63.0 is the first
release that does not.

The `dist` is rebuilt with **eve 0.63.0**, which re-stamps `dist/extension/_manifest.json` from
**tool 30 / dynamicTool 29 / hook 20** to **tool 53 / dynamicTool 51 / hook 24** (`extension` 1,
`instructions` 2, `config` 1 and `formatVersion` 2 unchanged). 0.63.0 is the only release accepting the new
stamps — 0.62.0 rejects tool 53 / dynamicTool 51 — so the `eve` peer moves `">=0.55.0"` → `">=0.63.0"`.
Verified by packing the rebuilt extension into a real eve app: on eve 0.62.0 it fails `eve build` with the
same *"has no compile or runtime usage"*, on eve 0.63.0 it builds and mounts all seven tools plus the
chat-history hook. Anyone pinned to an eve below 0.63.0 should stay on `0.10.0`.

**One source change, also a fix:** since eve 0.59.0 dynamic tools are replayed from a durable JSON
snapshot, and a live schema captured from a resolver is rejected at session start (`Dynamic tool
"agentkit__search" callback "inputSchema" has a non-serializable capture` — logged, and the tool silently
never mounts). `search`, `search_aggregate` and `search_count` passed eve the live zod schema derived from
your `search.schema`, so on eve 0.59–0.62 the extension mounted without its three search tools. They now
hand eve plain JSON Schema (`z.toJSONSchema(...)`, computed in the resolver), which eve rehydrates into its
own validator; the model sees the same fields and descriptions as before. The mocked smoke eval in
`examples/eve-extension-demo` now calls `agentkit__search_count` so a dynamic tool that fails to mount
fails the eval instead of a log line nobody reads.

`@upstash/agentkit-eve` gets no release here: its `dist` is byte-identical to the published `0.9.0`, so
only its devDependency moved.
