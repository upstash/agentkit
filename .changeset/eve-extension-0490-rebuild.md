---
"@upstash/agentkit-eve-extension": minor
---

fix!: rebuild against eve 0.49.0 and raise the `eve` peer floor to `>=0.48.0`

The extension is now built with **eve 0.49.0**, whose
`dist/extension/_manifest.json` stamps formatVersion 2 and contracts
extension 1 / **tool 24** / dynamicTool 21 / hook 16 / instructions 2 / config 1 —
up from **tool 21** in the published `0.8.0` build (eve 0.47.3). Only the tool
contract moved; every other contribution contract is unchanged. This supersedes the
unreleased intermediate rebuild on eve 0.47.6 (tool 22, floor `>=0.47.5`), which
never shipped.

eve 0.48.0 is the first release whose `EXTENSION_CAPABILITY_CONTRACTS` accept tool
24, so the `eve` peer moves from `">=0.47.0"` to `">=0.48.0"`. **The tool contract
moved twice inside three eve patch/minor releases** — 22 → 23 in **0.47.7** and
23 → 24 in **0.48.0** — so 0.47.7 is *not* sufficient either, and neither is any
0.47.x: 0.47.0–0.47.3 top out at tool 21, 0.47.5/0.47.6 at tool 22, 0.47.7 at tool
23 (0.47.4 was never published). Verified by packing the rebuilt extension into a
real eve app: on eve 0.47.5, 0.47.6 and 0.47.7 it installs cleanly and then fails
`eve build` with `Selected module binding "extensions/agentkit.ts" has no compile or
runtime usage.`, while eve 0.48.0 and 0.49.0 build and mount every contribution.
Contribution contracts move in *patch* releases, so always re-derive the floor from
the freshly built manifest rather than from the minor version.

No extension source changed; all packages build, typecheck, lint and pass their
tests against eve 0.49.0.
