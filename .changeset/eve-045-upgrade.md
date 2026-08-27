---
"@upstash/agentkit-eve-extension": minor
---

fix!: rebuild against eve 0.45.2 and raise the `eve` peer floor to `>=0.45.1`

`eve extension build` stamps `dist/extension/_manifest.json` with the *building*
eve's current contribution-format versions, and a consumer rejects any version
missing from its own supported list — so the eve an extension is built with
decides the eve range it loads on. `@upstash/agentkit-eve-extension@0.7.0` was
built with eve 0.44.3 (tool 17 / dynamicTool 18) and declared `">=0.43.0"`.
Rebuilding on **eve 0.45.2** re-stamps the manifest to **tool 19 /
dynamicTool 19** (hook 14 and instructions 2 unchanged).

The floor that implies is **0.45.1, not 0.45.0** — eve raised the tool contract
*inside* the 0.45 patch line. 0.45.0 tops out at tool 18, 0.45.1 is the first
release accepting tool 19, and every 0.42–0.44.4 tops out at tool 17 /
dynamicTool 18.

- The extension is now built with **eve 0.45.2** (manifest: formatVersion 2,
  tool 19 / dynamicTool 19 / hook 14 / instructions 2) and loads on
  **eve ≥ 0.45.1**.
- The `eve` peer dependency moves from `">=0.43.0"` to `">=0.45.1"`, so an
  incompatible eve fails at install time with an actionable message instead of
  at `eve build`. Verified empirically against the built dist in a scratch
  consumer: `eve build` exits 1 on eve 0.45.0 and 0 on both eve 0.45.1 and
  eve 0.45.2.

`@upstash/agentkit-eve` is deliberately **not** bumped here. Its `eve` peer stays
`">=0.32.0"` — 0.32 is where the `SandboxBackendHandle.stop()` contract the
Upstash Box backend implements landed, and the source still typechecks against
it. Only its `eve` **devDependency** moved to `^0.45.2`, which never reaches the
published tarball, so nothing about that package changed for consumers.

No runtime behavior and no source changed: every package builds, typechecks and
lints, the test suite passes, all three example apps build and the extension
demo's mocked-model end-to-end eval is green — all unmodified against eve 0.45.2.
eve 0.45.0 removed `eve/tools/defaults` and the `defineBashTool` /
`defineReadFileTool` / `defineWriteFileTool` / `defineGlobTool` /
`defineGrepTool` factories, and dropped `experimental.subagentPersistentSessions`
— AgentKit uses none of them. `ai` stays exact-pinned at `7.0.58` (eve 0.45's
peer is still `^7.0.58`).

Takeaway for the next bump: an eve **patch** release can move a contribution
contract, so always re-derive the floor from the freshly built manifest instead
of assuming the minor version is enough.
