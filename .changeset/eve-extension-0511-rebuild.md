---
"@upstash/agentkit-eve-extension": minor
---

fix!: rebuild against eve 0.51.1 and raise the `eve` peer floor to `>=0.51.1`

**If you are on eve 0.50.0 or newer, the currently published `0.8.0` is broken and this
release is the fix.** eve 0.50.0 *dropped* two contribution contracts that the `0.8.0`
build stamps — `dynamicTool 21` and `hook 16` — so `0.8.0` still **installs** cleanly
(its `eve` peer was the permissive `">=0.47.0"`) and then fails `eve build` with the
obtuse `Selected module binding "extensions/agentkit.ts" has no compile or runtime
usage.` This is the first time an eve release *removed* support for a contract instead
of merely moving it forward, which is why a floor alone did not protect consumers.

The extension is now built with **eve 0.51.1**, whose `dist/extension/_manifest.json`
stamps formatVersion 2 and contracts extension 1 / **tool 27** / **dynamicTool 27** /
**hook 20** / instructions 2 / config 1 — up from tool 21 / dynamicTool 21 / hook 16 in
the published `0.8.0` build (eve 0.47.3). `instructions`, `config` and `extension` are
unchanged. The `eve` peer moves `">=0.47.0"` → **`">=0.51.1"`** so an incompatible eve
now fails at *install* instead of at `eve build`.

The floor was derived **empirically, not from the version number**: the rebuilt tarball
was packed into a real eve app and `eve build` run against each candidate. It fails on
eve 0.48.0, 0.49.0, 0.49.1, 0.50.0 and 0.51.0 with the "no compile or runtime usage"
error, and succeeds only on **0.51.1** — which is therefore the true floor. Contribution
contracts move (and now disappear) in *patch* releases, so always re-derive the floor
from the freshly built manifest against real eve versions.

This supersedes the two earlier unreleased rebuilds that never shipped — eve 0.47.6
(tool 22, floor `>=0.47.5`) and eve 0.49.0 (tool 24, floor `>=0.48.0`). Everything above
is stated against the last **published** state, `0.8.0`.

No extension source changed; all packages build, typecheck, lint and pass their tests
against eve 0.51.1, as do both example builds and the mocked-model extension eval.
