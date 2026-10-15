---
"@upstash/agentkit-eve-extension": minor
---

fix!: rebuild the extension against `eve` 0.79.1 and raise the `eve` peer floor to `>=0.79.1`

The dist is now built with **eve 0.79.1** (`builtWithEve: "0.79.1"`) and its `dist/extension/_manifest.json` stamps tool contract **90**, dynamicTool **84** and hook **45** (previously 78 / 73 / 39, built with eve 0.74.0). 0.79.1 is the first eve that accepts them (0.74.0–0.79.0 refuse them with `Selected module binding "extensions/agentkit.ts" has no compile or runtime usage.`), so the peer range moves `">=0.74.0"` → **`">=0.79.1"`**: an eve that cannot run this dist is rejected at install instead of failing at `eve build`.

**Upgrading:** move your app to `eve@^0.79.1` or newer together with this release.
