---
"@upstash/agentkit-eve-extension": minor
---

fix!: rebuild the extension against `eve` 0.68.0 and raise the `eve` peer floor to `>=0.68.0`

The dist is now built with **eve 0.68.0** and its `dist/extension/_manifest.json` stamps tool
contract **59**, dynamicTool **56** and hook **29** (previously 55 / 52 / 25, built with 0.65.0).
0.68.0 is the first eve that accepts all three: 0.67.0–0.67.2 accept dynamicTool 56 but not tool 59 or
hook 29, and 0.65.0–0.66.3 accept none of them. The peer range therefore moves `">=0.65.0"` →
**`">=0.68.0"`**, so an eve that cannot run this dist is rejected at install (`ERESOLVE`) instead of
installing cleanly and then failing at `eve build` with
`Selected module binding "extensions/agentkit.ts" has no compile or runtime usage.`

**Upgrading:** move your app to `eve@^0.68.0` together with this release. If you must stay on
eve 0.65–0.67, stay on `@upstash/agentkit-eve-extension@0.13.0`, which also keeps working on eve 0.68.

**No behaviour or API changed**: the same extension source recompiled against a newer eve. The mount,
its options, every contributed tool and hook, and everything written to Redis are unchanged.
