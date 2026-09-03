---
"@upstash/agentkit-eve-extension": minor
---

fix!: rebuild against eve 0.50.0 and raise the `eve` peer floor to `>=0.50.0`

The extension is now built with **eve 0.50.0**, whose
`dist/extension/_manifest.json` stamps formatVersion 2 and contracts
extension 1 / tool 24 / **dynamicTool 22** / **hook 17** / instructions 2 / config 1 —
up from tool 21 / **dynamicTool 21** / **hook 16** in the published `0.8.0` build
(eve 0.47.3). The `eve` peer moves from `">=0.47.0"` to `">=0.50.0"`.

**The published `0.8.0` does not work on eve 0.50.0.** eve 0.50.0 *dropped*
`dynamicTool` contract 21 and `hook` contract 16 outright — both with the reason
"Message and reasoning append events now expose deltas instead of cumulative
snapshots" — and `0.8.0`'s manifest requires exactly those two. Its `tool` contract
(21) is still supported, so this break is invisible if you only read the tool
number. Because the published peer floor (`">=0.47.0"`) admits 0.50.0, affected
users install cleanly and only fail later at `eve build`, with:

```
Selected module binding "extensions/agentkit.ts" has no compile or runtime usage.
```

**eve 0.50.0 is the first — and currently only — release that accepts the new
build.** 0.48.0, 0.49.0 and 0.49.1 all accept tool 24 but top out at dynamicTool 21
and hook 16; 0.47.7 tops out at tool 23. Derived by running eve's own
`findUnsupportedExtensionCapabilities()` from
`dist/src/compiler/extension-compatibility.js` over the freshly generated manifest
against every candidate release, then confirmed end-to-end by packing the rebuilt
extension into a real eve app: on **eve 0.50.0** it installs and `eve build`
succeeds with every contribution mounted, while on **eve 0.49.0** the new floor now
stops it at install time —
`npm error ERESOLVE ... peer eve@">=0.50.0" from @upstash/agentkit-eve-extension` —
which is the point of the floor: fail at install, not at build (issue #22).

Three consecutive prior bumps moved the `tool` contract, so this is worth
restating: **contribution contracts move independently and can be dropped, not just
raised, in a patch or minor release.** Re-derive the floor from every entry in the
freshly built manifest's `requires` block, never from the tool contract alone and
never from the eve version number.

No extension source changed. `@upstash/agentkit-eve` is unaffected: its published
`dist` names no post-0.32 eve type, it typechecks clean for consumers on every eve
from 0.32.0 through 0.50.0, and its peer floor stays `">=0.32.0"`.
