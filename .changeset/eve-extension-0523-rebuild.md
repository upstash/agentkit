---
"@upstash/agentkit-eve-extension": minor
---

chore: rebuild against eve 0.55.0 and raise the `eve` peer floor to `>=0.55.0`

No source changed. The extension's `dist` is rebuilt with **eve 0.55.0**, which re-stamps
`dist/extension/_manifest.json` relative to the published `0.10.0` build (eve 0.52.2):
**tool 30 → 38**, **dynamicTool 29 → 37**, **hook 20 → 22**. `extension` 1, `instructions` 2
and `config` 1 are unchanged, and `formatVersion` stays 2. Every compiled `.mjs` and `.d.ts` in
`dist/` is byte-identical to `0.10.0` — `_manifest.json` is the only file that differs.

eve 0.55.0 is the only release accepting the new stamps — 0.54.4/0.54.5 top out at tool 36 /
dynamicTool 35, and 0.52.3 (which this changeset previously targeted, never released) at tool 32 /
dynamicTool 31 — so the `eve` peer moves `">=0.52.2"` → `">=0.55.0"`. Verified by packing the
rebuilt extension into a real eve app: on eve 0.54.5 it fails `eve build` with
`Selected module binding "extensions/agentkit.ts" has no compile or runtime usage.`, while on
eve 0.55.0 it builds and mounts all seven tools plus the chat-history hook.

**This release does not fix a break.** eve 0.55.0 still supports tool 30 / dynamicTool 29 /
hook 20 (its `tool` list is [1–13, 28–32, 34–38]), so the contracts the published `0.10.0`
requires are still accepted and `0.10.0` installs and builds cleanly on eve 0.55.0 — verified in a
scratch consumer on `eve@latest`, which mounts all seven tools and the hook. This release only
keeps the stamps current; its one consumer-visible effect is that the raised floor makes it
unusable on any eve below 0.55.0, so anyone pinned to an older eve should stay on `0.10.0`.

`@upstash/agentkit-eve` gets no release here: its `dist` is byte-identical before and after the
bump, so only its devDependency moved.
