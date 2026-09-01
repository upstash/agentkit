---
"@upstash/agentkit-eve-extension": minor
---

fix!: rebuild against eve 0.47.6 and raise the `eve` peer floor to `>=0.47.5`

The extension is now built with **eve 0.47.6**, whose
`dist/extension/_manifest.json` stamps formatVersion 2 and contracts
extension 1 / **tool 22** / dynamicTool 21 / hook 16 / instructions 2 / config 1 —
up from **tool 21** in the published `0.8.0` build (eve 0.47.3). Only the tool
contract moved this time; every other contribution contract is unchanged.

eve 0.47.5 is the first release whose `EXTENSION_CAPABILITY_CONTRACTS` accept tool
22 (0.47.0–0.47.3 top out at tool 21, and 0.47.4 was never published), so the `eve`
peer moves from `">=0.47.0"` to `">=0.47.5"`. Verified by packing the rebuilt
extension into a real eve app: on eve 0.47.0–0.47.3 it installs cleanly and then
fails `eve build` with `Selected module binding "extensions/agentkit.ts" has no
compile or runtime usage.`, while eve 0.47.5 and 0.47.6 build and mount every
contribution. Contribution contracts move in *patch* releases, so always re-derive
the floor from the freshly built manifest rather than from the minor version.

No extension source changed; all packages build, typecheck, lint and pass their
tests against eve 0.47.6.
