---
"@upstash/agentkit-eve-extension": minor
"@upstash/agentkit-eve": minor
---

feat!: rebuild against eve 0.44 so the extension loads on current eve (fixes #22)

`@upstash/agentkit-eve-extension@0.6.0` was built with eve 0.32.0, stamping hook
contract v9 in its `dist/extension/_manifest.json` — a contract eve 0.33.0
dropped, so the extension failed `eve build` on every eve released after 0.32.0.

- The extension is now built with **eve 0.44.3** (manifest: formatVersion 2,
  tool 17 / dynamicTool 18 / hook 14 / instructions 2) and loads on
  **eve ≥ 0.43.0**.
- The extension's `eve` peer dependency is tightened from `"*"` to
  `">=0.43.0"`, so an incompatible eve now fails at install time with an
  actionable message instead of at `eve build`.
- `@upstash/agentkit-eve`'s `eve` peer is corrected from `>=0.24.0` to
  `>=0.32.0` — the Upstash Box sandbox backend implements the `stop()` handle
  contract eve requires since 0.32.

No runtime behavior changed; all sources compile and pass unmodified against
eve 0.44.3.
