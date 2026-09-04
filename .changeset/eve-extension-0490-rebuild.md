---
"@upstash/agentkit-eve-extension": minor
---

fix!: rebuild against eve 0.49.0 and raise the `eve` peer floor to `>=0.48.0`

No source changed. The extension's `dist` is rebuilt with eve 0.49.0, which re-stamps the manifest's
tool contract 21 → 24 (every other contribution contract is unchanged). eve 0.48.0 is the first
release accepting tool 24, so the `eve` peer moves `">=0.47.0"` → `">=0.48.0"`.

No 0.47.x works, including 0.47.7 — the tool contract moved twice in three releases (22 → 23 in
0.47.7, 23 → 24 in 0.48.0). On an unsupported eve the mount contributes nothing and `eve build`
fails with `Selected module binding "extensions/agentkit.ts" has no compile or runtime usage.`

This supersedes the unreleased 0.47.6 rebuild (tool 22, floor `>=0.47.5`), which never shipped.
