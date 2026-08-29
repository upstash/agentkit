---
"@upstash/agentkit-eve-extension": minor
---

fix!: rebuild against eve 0.47.3 and raise the `eve` peer floor to `>=0.47.0`

`eve extension build` stamps the compatibility manifest with the *building* eve's
current contribution-format versions, and a consumer rejects any version missing
from its own supported list. Rebuilding on **eve 0.47.3** re-stamps
`dist/extension/_manifest.json` to **tool 21 / dynamicTool 21 / hook 16**
(`instructions` 2, `extension` 1 and `config` 1 are unchanged), and eve 0.47.0 is
the first release supporting all three — 0.46.1 tops out at tool 20 /
dynamicTool 20 / hook 15, and 0.45.x at tool 19 / dynamicTool 19 / hook 14.

- The extension is now built with **eve 0.47.3** (manifest: formatVersion 2,
  tool 21 / dynamicTool 21 / hook 16 / instructions 2) and loads on
  **eve ≥ 0.47.0**.
- The `eve` peer dependency moves from `">=0.43.0"` to `">=0.47.0"` so an
  incompatible eve fails at install time rather than at `eve build`. Verified end
  to end: a consumer on eve 0.46.1 installs fine under the old floor and then
  fails `eve build` with the unhelpful *"Selected module binding
  "extensions/agentkit.ts" has no compile or runtime usage."*; the same consumer
  on eve 0.47.0 builds and mounts all eight `agentkit__*` contributions.

No runtime behavior and no source changed: the extension builds, typechecks and
passes unmodified against eve 0.47.3, `examples/eve-extension-demo` builds, and
the extension's mocked-model end-to-end eval is green. `ai` stays exact-pinned at
`7.0.58` (eve 0.47.3's peer is still `^7.0.58`).

`@upstash/agentkit-eve` is **not** part of this release and is intentionally held
back on `eve@^0.45.0`, with its `eve` peer unchanged at `>=0.32.0`. eve 0.47.0
added a required `delete(options?: SandboxDeleteOptions): Promise<void>` member to
`SandboxBackendHandle`, and the Upstash Box sandbox backend at
`packages/eve/src/sandbox.ts:539` does not implement it yet, so that package does
not compile against eve ≥ 0.47.0. Its published content is unchanged here; moving
it needs a separate change that adds `delete` (calling `@upstash/box`'s
`Box.delete()`, alongside the existing `stop`/`shutdown`) and then raises its peer
floor to `>=0.47.0`.
