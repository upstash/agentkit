---
"@upstash/agentkit-eve-extension": minor
---

fix!: rebuild against eve 0.47.3 and raise the `eve` peer floor to `>=0.47.0`

The extension is now built with **eve 0.47.3**, which stamps
`dist/extension/_manifest.json` with formatVersion 2 and contracts
extension 1 / **tool 21** / **dynamicTool 21** / **hook 16** / instructions 2 /
config 1 — up from tool 19 / dynamicTool 19 / hook 14 on the 0.45.2 build.

eve 0.47.0 is the first release whose `EXTENSION_CAPABILITY_CONTRACTS` accept
those versions (0.46.1 tops out at tool 20 / hook 15, 0.45.1–0.46.0 at tool 19 /
hook 14), so the `eve` peer moves from `">=0.45.1"` to `">=0.47.0"`. Verified by
mounting the rebuilt extension in a real eve app: it builds on eve 0.47.0 and
fails on 0.46.1.

No extension source changed; all packages build, typecheck, lint and pass their
tests against eve 0.47.3.
