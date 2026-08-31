---
"@upstash/agentkit-eve-extension": minor
---

fix!: rebuild against eve 0.47.3 and raise the `eve` peer floor to `>=0.47.0`

The extension is now built with **eve 0.47.3**, whose
`dist/extension/_manifest.json` stamps formatVersion 2 and contracts
extension 1 / **tool 21** / **dynamicTool 21** / **hook 16** / instructions 2 /
config 1 — up from tool 17 / dynamicTool 18 / hook 14 in the published
`0.7.0` build (eve 0.44.3). This supersedes the unreleased intermediate rebuilds
on eve 0.45.0/0.45.2 (tool 18/19), which never shipped.

eve 0.47.0 is the first release whose `EXTENSION_CAPABILITY_CONTRACTS` accept
those contracts (0.46.1 tops out at tool 20 / hook 15; 0.45.1–0.46.0 at tool 19 /
hook 14; 0.45.0 at tool 18; 0.43.0–0.44.4 at tool 17), so the `eve` peer moves
from `">=0.43.0"` to `">=0.47.0"`. Verified by mounting the rebuilt extension in
a real eve app: it builds on eve 0.47.0 and fails on 0.46.1. Contribution
contracts move in *patch* releases, so always re-derive the floor from the freshly
built manifest.

No extension source changed; all packages build, typecheck, lint and pass their
tests against eve 0.47.3.
