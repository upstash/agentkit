---
"@upstash/agentkit-eve-extension": minor
---

fix!: rebuild against eve 0.45 and raise the `eve` peer floor to `>=0.45.0`

`eve extension build` stamps the compatibility manifest with the *building* eve's
current contribution-format versions, and a consumer rejects any version missing
from its own supported list. Rebuilding on **eve 0.45.0** re-stamps
`dist/extension/_manifest.json` from tool 17 / dynamicTool 18 to
**tool 18 / dynamicTool 19** (hook 14 and instructions 2 are unchanged), and
eve 0.45.0 is the first release supporting either — every 0.42–0.44.4 tops out at
tool 17 / dynamicTool 18.

- The extension is now built with **eve 0.45.0** (manifest: formatVersion 2,
  tool 18 / dynamicTool 19 / hook 14 / instructions 2) and loads on **eve ≥ 0.45.0**.
- The `eve` peer dependency moves from `">=0.43.0"` to `">=0.45.0"` so an
  incompatible eve fails at install time rather than at `eve build`, where it
  otherwise errors with *"requires tool contract v18, but this eve supports tool
  contract versions: … v17"*.

`@upstash/agentkit-eve`'s `eve` peer stays `>=0.32.0` — its source still
typechecks cleanly against eve 0.32.0, so no floor change is warranted there.

No runtime behavior and no source changed: all packages build, typecheck and pass
unmodified against eve 0.45.0, both demos build, and the extension's mocked-model
end-to-end eval is green. eve 0.45.0 removed `eve/tools/defaults` and the
`defineBashTool`/`defineReadFileTool`/`defineWriteFileTool`/`defineGlobTool`/
`defineGrepTool` factories, and dropped `experimental.subagentPersistentSessions`
— AgentKit uses none of them. `ai` stays exact-pinned at `7.0.58` (eve 0.45's peer
is still `^7.0.58`).
