---
"@upstash/agentkit-eve-extension": minor
---

fix!: rebuild the extension against `eve` 0.81.1 and raise the `eve` peer floor to `>=0.81.0`

The dist is now built with **eve 0.81.1** (`builtWithEve: "0.81.1"`) and its `dist/extension/_manifest.json` stamps tool contract **93**, dynamicTool **87** and hook **47** (previously 78 / 73 / 39, built with eve 0.74.0). 0.81.0 is the first eve that accepts them (0.80.0, 0.80.1 and 0.79.2 refuse them with `Extension "@upstash/agentkit-eve-extension" requires … contract v…`), so the peer range moves `">=0.74.0"` → **`">=0.81.0"`**: an eve that cannot run this dist is rejected at install instead of failing at `eve build`.

**Upgrading:** move your app to `eve@^0.81.0` or newer together with this release.
