---
"@upstash/agentkit-eve-extension": minor
---

fix!: rebuild against eve 0.47.3 and raise the `eve` peer floor to `>=0.47.0`

The extension is now built with **eve 0.47.3**. `eve extension build` stamps
`dist/extension/_manifest.json` with the building eve's contribution-format
versions, so this rebuild moves them to **tool 21, dynamicTool 21, hook 16**
(instructions 2, config 1, extension 1; formatVersion 2).

A consumer's eve rejects any contract version outside its own supported list, so
the `eve` peer moves from `">=0.43.0"` to **`">=0.47.0"`** — the oldest eve that
supports all three of tool 21, dynamicTool 21 and hook 16. Derived from eve's own
`EXTENSION_CAPABILITY_CONTRACTS` across 0.45.2–0.47.3: 0.45.2 and 0.46.0 top out
at tool/dynamicTool 19 + hook 14, 0.46.1 at 20/20/15, and 0.47.0 is the first
release accepting 21/21/16.

**Upgrade note:** move your app to **eve >= 0.47.0** before taking this release.
The currently published build (manifest tool 17) still loads on eve 0.43–0.46.x;
this one does not, and on a too-old eve the failure surfaces indirectly at
`eve build` ("Invalid compiled eve artifact: compiled binding
"extensions/agentkit.ts" is not referenced by its node manifest") rather than as
a contract-version message — which is exactly why the peer floor is raised to
catch it at install time instead.

No source changed: the extension builds, typechecks, passes its own test suite
and the mocked-model e2e eval unmodified against eve 0.47.3.
