---
"@upstash/agentkit-eve-extension": minor
---

fix!: rebuild the extension against `eve` 0.69.0 and raise the `eve` peer floor to `>=0.69.0`

eve 0.69.0 dropped tool contract 59, dynamicTool 56 and hook 29, which are the contracts
`@upstash/agentkit-eve-extension@0.14.0` (built with eve 0.68.0) requires. On eve 0.69.0, 0.14.0
installs cleanly and then fails `eve build` with
`Selected module binding "extensions/agentkit.ts" has no compile or runtime usage.`

The dist is now built with **eve 0.69.0** and its `dist/extension/_manifest.json` stamps tool
contract **71**, dynamicTool **68** and hook **35** (previously 59 / 56 / 29). 0.69.0 is the first eve
that accepts them (0.65.0–0.68.0 accept none of the three), so the peer range moves `">=0.68.0"` →
**`">=0.69.0"`**: an eve that cannot run this dist is rejected at install (`ERESOLVE`) instead of
failing at `eve build`.

**Upgrading:** move your app to `eve@^0.69.0` together with this release. If you must stay on eve 0.68,
stay on `@upstash/agentkit-eve-extension@0.14.0` (it does not work on eve 0.69).

**No behaviour or API changed**: the same extension source recompiled against a newer eve. The mount,
its options, every contributed tool and hook, and everything written to Redis are unchanged.
