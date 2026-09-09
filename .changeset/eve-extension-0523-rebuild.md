---
"@upstash/agentkit-eve-extension": minor
---

chore: rebuild against eve 0.52.3 and raise the `eve` peer floor to `>=0.52.3`

No source changed. The extension's `dist` is rebuilt with **eve 0.52.3**, which re-stamps
`dist/extension/_manifest.json` relative to the published `0.10.0` build (eve 0.52.2):
**tool 30 → 32**, **dynamicTool 29 → 31**, **hook 20 → 22**. `extension` 1, `instructions` 2
and `config` 1 are unchanged, and `formatVersion` stays 2.

eve 0.52.3 is the only release accepting the new stamps — 0.52.2 tops out at tool 30 /
dynamicTool 29 / hook 20 — so the `eve` peer moves `">=0.52.2"` → `">=0.52.3"`. Verified by
packing the rebuilt extension into a real eve app: on eve 0.52.2 it fails `eve build` with
`Selected module binding "extensions/agentkit.ts" has no compile or runtime usage.`, while on
eve 0.52.3 it builds and mounts all seven tools plus the chat-history hook.

**Unlike the `0.10.0` rebuild, this one does not fix a break.** eve 0.52.3 *added* tool 31/32
without dropping 30, so the contracts the published `0.10.0` requires are still supported and
`0.10.0` installs and builds cleanly on eve 0.52.3. This release only keeps the stamps current;
its one consumer-visible effect is that the raised floor makes it unusable on eve 0.52.2, so
anyone pinned to 0.52.2 should stay on `0.10.0`.

`@upstash/agentkit-eve` gets no release here: its `dist` is byte-identical before and after the
bump, so only its devDependency moved.
