---
"@upstash/agentkit-eve-extension": minor
---

chore: rebuild against eve 0.54.3 and raise the `eve` peer floor to `>=0.54.3`

No source changed. The extension's `dist` is rebuilt with **eve 0.54.3**, which re-stamps
`dist/extension/_manifest.json` relative to the published `0.10.0` build (eve 0.52.2):
**tool 30 → 36**, **dynamicTool 29 → 34**, **hook 20 → 22**. `extension` 1, `instructions` 2
and `config` 1 are unchanged, and `formatVersion` stays 2.

eve 0.54.3 is the only release accepting the new stamps — 0.54.2 and 0.54.0 top out at tool 35 /
dynamicTool 33, and 0.53.1 at tool 34 / dynamicTool 32 — so the `eve` peer moves
`">=0.52.2"` → `">=0.54.3"`. Verified by packing the rebuilt extension into a real eve app: on
eve 0.54.2 it fails `eve build` with
`Selected module binding "extensions/agentkit.ts" has no compile or runtime usage.`, while on
eve 0.54.3 it builds and mounts all seven tools plus the chat-history hook.

**Unlike the `0.10.0` rebuild, this one does not fix a break.** eve 0.54.3 still supports tool 30 /
dynamicTool 29 / hook 20, so the contracts the published `0.10.0` requires are all still accepted and
`0.10.0` installs and builds cleanly on eve 0.54.3 — confirmed in a scratch consumer built from the
real registry with `eve@latest` + `@upstash/agentkit-eve-extension@latest`, which mounts all seven
tools and the hook and runs `eve build` green. This release only keeps the stamps current; its one
consumer-visible effect is that the raised floor makes it unusable on eve 0.52.2 through 0.54.2, so
anyone pinned below 0.54.3 should stay on `0.10.0`.

`@upstash/agentkit-eve` needs no rebuild for the eve bump — its `dist` is unchanged by it and only its
devDependency moved. It ships a separate release here for an unrelated peer-floor correction.
