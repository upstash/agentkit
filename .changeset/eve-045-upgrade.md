---
"@upstash/agentkit-eve-extension": minor
"@upstash/agentkit-eve": minor
---

feat!: rebuild against eve 0.45 and raise the extension's eve peer floor to >=0.45.0

eve 0.45.0 bumped two extension contribution contracts — `tool` 17 → 18 and
`dynamicTool` 18 → 19 — so a dist rebuilt on 0.45 no longer loads on any earlier
eve, and the previous `">=0.43.0"` peer floor would let an incompatible eve
install cleanly and then fail at `eve build`.

- `eve` is bumped to **0.45.0** across `packages/eve`, `packages/eve-extension`
  and both eve demos. The rebuilt extension manifest stamps
  `builtWithEve: 0.45.0` with formatVersion 2, tool 18 / dynamicTool 19 /
  hook 14 / instructions 2.
- The extension's `eve` peer floor is corrected from `">=0.43.0"` to
  `">=0.45.0"` so an incompatible eve fails at install time with an actionable
  message instead of at `eve build` with
  `Extension "@upstash/agentkit-eve-extension" requires tool contract v18, but
  this eve supports tool contract versions: …v17`.
- `@upstash/agentkit-eve`'s `eve` peer stays `>=0.32.0` — every export it uses
  (`defineTool`, `ToolDefinition`, `ToolContext`, `ForbiddenError`, `AuthFn` and
  the `eve/sandbox` type set) is unchanged in 0.45.

No runtime behavior changed; all sources compile and pass unmodified against
eve 0.45.0, and `ai` stays exact-pinned at `7.0.58` (eve 0.45's peer is still
`^7.0.58`).
