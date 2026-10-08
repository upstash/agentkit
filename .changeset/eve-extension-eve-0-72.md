---
"@upstash/agentkit-eve-extension": minor
---

fix!: rebuild the extension against `eve` 0.74.0 and raise the `eve` peer floor to `>=0.74.0`

`@upstash/agentkit-eve-extension@0.15.0` fails `eve build` on eve 0.72.x and newer with
`Selected module binding "extensions/agentkit.ts" has no compile or runtime usage.`: eve 0.72.0 dropped
tool contract 71 (the stamp 0.15.0 carries).

The dist is now built with **eve 0.74.0** (`builtWithEve: "0.74.0"`) and its
`dist/extension/_manifest.json` stamps tool contract **78**, dynamicTool **73** and hook **39**
(previously 71 / 68 / 35, built with eve 0.69.0 in `@upstash/agentkit-eve-extension@0.15.0`). 0.74.0 is
the first eve that accepts them (0.72.0–0.73.0 refuse them), so the peer range moves
`">=0.69.0"` → **`">=0.74.0"`**: an eve that cannot run this dist is rejected at install
(`ERESOLVE`) instead of failing at `eve build`.

**Upgrading:** move your app to `eve@^0.74.0` or newer together with this release. If you must stay on
eve 0.69–0.71, stay on `@upstash/agentkit-eve-extension@0.15.0`.

**No behaviour or API changed**: the same extension source recompiled against a newer eve.
