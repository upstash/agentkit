---
"@upstash/agentkit-eve-extension": minor
---

fix!: rebuild against eve 0.45.2 and raise the `eve` peer floor to `>=0.45.1`

The extension is now built with **eve 0.45.2**, which stamps
`dist/extension/_manifest.json` with tool contract 19 (dynamicTool 19, hook 14,
instructions 2). eve raised the tool contract inside the 0.45 patch line, so the
`eve` peer moves from `">=0.43.0"` to `">=0.45.1"` — the oldest eve that accepts
tool 19, and one patch newer than the minor alone would suggest.

No source changed; all packages build, typecheck and pass against eve 0.45.2.
