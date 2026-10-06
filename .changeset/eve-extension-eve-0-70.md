---
"@upstash/agentkit-eve-extension": minor
---

chore!: rebuild the extension against `eve` 0.71.2 and raise the `eve` peer floor to `>=0.70.0`

The dist is now built with **eve 0.71.2** (`builtWithEve: "0.71.2"`) and its
`dist/extension/_manifest.json` stamps tool contract **73**, dynamicTool **70** and hook **37**
(previously 71 / 68 / 35, built with eve 0.69.0 in `@upstash/agentkit-eve-extension@0.15.0`). 0.70.0 is
the first eve that accepts them (0.70.0 through 0.71.2 ship the identical capability table), while 0.69.0
tops out at 71 / 68 / 35 and fails `eve build` on this dist with
`Selected module binding "extensions/agentkit.ts" has no compile or runtime usage.` — so the peer range
moves `">=0.69.0"` → **`">=0.70.0"`**: an eve that cannot run this dist is rejected at install
(`ERESOLVE`) instead of failing at `eve build`.

**Upgrading:** move your app to `eve@^0.70.0` or newer together with this release. This is not a fix for a
break: eve 0.70.x–0.71.x still accept 0.15.0's contracts, so if you must stay on eve 0.69, stay on
`@upstash/agentkit-eve-extension@0.15.0` (it works on eve 0.69 through 0.71.2).

**No behaviour or API changed**: the same extension source recompiled against a newer eve.
