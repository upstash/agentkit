---
"@upstash/agentkit-eve-extension": minor
---

feat!: rebuild the extension against `eve` 0.67.2 and raise the `eve` peer floor to `>=0.67.0`

This release ships a `dist/extension/_manifest.json` rebuilt with **eve 0.67.2**, stamping tool
contract **58**, dynamicTool **56** and hook **28** (was tool 55 / dynamicTool 52 / hook 25 from eve
0.65.0 in `0.13.0`). **0.67.0 is the first eve that accepts those contracts**, so the `eve` peer moves
`">=0.65.0"` → **`">=0.67.0"`**.

**What this means for you:**

- **On eve ≥0.67.0:** upgrade as usual — nothing else to change.
- **On eve 0.65.x or 0.66.x:** upgrade eve to ≥0.67.0 first, or stay on `0.13.0`, which still
  works on eve 0.65.0 through the current 0.67.2. If you force-install this version next to an older eve,
  npm rejects it with `ERESOLVE`. Otherwise every `eve build` / `eve dev` / `eve eval` fails with
  `Selected module binding "extensions/agentkit.ts" has no compile or runtime usage.`, eve's error for a
  mount whose manifest it cannot read.

Why move now, if `0.13.0` still works: eve regularly drops contract versions from the middle of its
supported range (0.67.0 dropped tool 57, the stamp an eve 0.66.x build would have carried). Staying on
the newest stamps keeps the published dist inside the range eve keeps supporting.

The floor was measured, not read off a table: the rebuilt dist, packed into fresh npm consumers,
**fails `eve build` on eve 0.65.0, 0.66.0 and 0.66.3** and **builds on 0.67.0 and 0.67.2**. The
mocked-model smoke eval, including a dynamic `search_count` call, passes 4/4 on 0.67.0.

**No behaviour and no API changed**: the same extension source is recompiled against a newer eve.
Every contribution, config option and export (`.` and `./tools`) is unchanged.
