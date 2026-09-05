---
"@upstash/agentkit-eve-extension": minor
---

fix!: rebuild against eve 0.52.1 and raise the `eve` peer floor to `>=0.52.0`

No source changed. The extension's `dist` is rebuilt with eve 0.52.1, which re-stamps the manifest's
contribution contracts **tool 24 → 29**, **dynamicTool 21 → 28** and **hook 16 → 20** (extension 1,
instructions 2 and config 1 are unchanged). eve 0.52.0 is the first release accepting tool 29 and
dynamicTool 28, so the `eve` peer moves `">=0.48.0"` → `">=0.52.0"`.

**If you are on `0.9.0`, you are probably already broken.** Unlike previous rounds, this is not just
a "new eve needs a newer build" bump — eve began *dropping* contribution contracts that the published
`0.9.0` dist depends on, so `0.9.0` stopped working on eve releases that shipped *after* it, with no
change on your side. eve 0.50.0 dropped dynamicTool 21 and hook 16 ("Message and reasoning append
events now expose deltas instead of cumulative snapshots"), and 0.52.0 dropped tool 24
("TaskExec.delegated was removed; migrate to workflow-backed background tools"). On any eve ≥0.50.0
the mount contributes nothing and `eve build` fails with:

```
Selected module binding "extensions/agentkit.ts" has no compile or runtime usage.
```

Because the old `">=0.48.0"` peer is open-ended, npm/pnpm install eve 0.50.0–0.52.1 without so much
as a warning and the failure only appears at build time. Upgrading to this release and moving to
eve ≥0.52.0 fixes it.

Verified end-to-end, not just from eve's contract tables: the rebuilt extension, packed into a real
eve app that mounts it and defines an `@upstash/agentkit-eve` tool, **fails on eve 0.51.1** with the
message above and **builds on 0.52.0 and 0.52.1**, mounting every contribution. The demo's
mocked-model eval (`examples/eve-extension-demo`) passes 3/3 gates on eve 0.52.1, exercising the real
tools and the chat-history hook against live Redis.

`@upstash/agentkit-eve` is unaffected and unchanged: its built `dist` is byte-identical to `0.9.0`
and its `eve` peer stays `">=0.32.0"`.
