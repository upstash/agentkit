---
"@upstash/agentkit-eve-extension": patch
"@upstash/agentkit-eve": patch
---

fix: support eve 0.45.2 and correct the extension's `eve` peer floor to `>=0.45.1`

The repo now develops and builds against **eve 0.45.2** (from 0.45.0). Nothing in
either package's source needed to change — build, typecheck, lint, the test suite,
all three example apps and the extension demo's mocked-model e2e eval are green
unmodified.

- `@upstash/agentkit-eve-extension` is rebuilt with **eve 0.45.2**, which re-stamps
  `dist/extension/_manifest.json` from tool 18 to **tool 19** (dynamicTool 19,
  hook 14, instructions 2 unchanged). eve raised the tool contract *within* the
  0.45 patch line, so the peer floor is corrected from `">=0.45.0"` to
  **`">=0.45.1"`** — the oldest eve whose `EXTENSION_CAPABILITY_CONTRACTS` accepts
  tool 19. Confirmed by building the dist in a scratch consumer: eve 0.45.0 fails,
  eve 0.45.1 and eve 0.45.2 both succeed.
- `@upstash/agentkit-eve`'s `eve` peer deliberately **stays `>=0.32.0`** — 0.32 is
  where the `SandboxBackendHandle.stop()` contract the Upstash Box backend
  implements landed, and the source still typechecks against it. A newer eve
  devDependency is not a reason to raise a peer floor.

Takeaway for future bumps: an eve **patch** release can change a contribution
contract, so always re-derive the floor from the freshly built manifest rather
than assuming the minor version is enough.
