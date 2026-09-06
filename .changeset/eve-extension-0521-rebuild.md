---
"@upstash/agentkit-eve-extension": minor
---

fix!: rebuild against eve 0.52.1 and raise the `eve` peer floor to `>=0.52.0`

No source changed. The extension's `dist` is rebuilt with eve 0.52.1, which re-stamps the manifest's
tool contract 24 → 29, dynamicTool 21 → 28 and hook 16 → 20 (extension 1, instructions 2 and config 1
are unchanged). eve 0.52.0 is the first release accepting all three, so the `eve` peer moves
`">=0.48.0"` → `">=0.52.0"`.

Three contracts moved at once because eve 0.50.0 was an explicitly extension-invalidating release —
its changelog requires every extension built against the previous dynamic-tool, hook and related
contracts to be rebuilt and republished — and eve 0.52.0 then dropped tool contracts 14–27 along with
`task.delegated()`. The previously published `0.9.0` build (eve 0.49.0) is therefore rejected by
**every eve >= 0.50.0**, not only 0.52.x. No 0.51.x works either: 0.51.1 already accepts hook 20 but
tops out at tool 27 / dynamicTool 27.

On an unsupported eve the mount contributes nothing and `eve build` fails with
`Selected module binding "extensions/agentkit.ts" has no compile or runtime usage.` The raised peer
floor now turns that into an install-time `ERESOLVE` instead, so the incompatibility surfaces before
the build.

If you are on eve 0.49.x or older, stay on `@upstash/agentkit-eve-extension@0.9.0`; upgrading requires
eve >= 0.52.0.
