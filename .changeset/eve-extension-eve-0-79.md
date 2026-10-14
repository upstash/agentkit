---
"@upstash/agentkit-eve-extension": minor
---

fix!: rebuild the extension against `eve` 0.79.0 and raise the `eve` peer floor to `>=0.79.0`

The dist is now built with **eve 0.79.0** (`builtWithEve: "0.79.0"`), so its compatibility manifest
requires tool contract 88, dynamicTool 83 and hook 45 (previously 78 / 73 / 39 with eve 0.74.0). Only
eve 0.79.0 accepts tool 88 / dynamicTool 83; 0.75.0–0.78.0 top out at 86 / 81. The `eve` peer is
therefore `>=0.79.0` instead of `>=0.74.0`.
