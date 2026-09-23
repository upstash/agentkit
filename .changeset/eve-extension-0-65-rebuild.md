---
"@upstash/agentkit-eve-extension": minor
---

fix!: rebuild the extension against `eve` 0.65.0 and raise the `eve` peer floor to `>=0.65.0` —
`0.12.0` cannot build on any eve released after it

`0.12.0` ships a `dist/extension/_manifest.json` built with **eve 0.63.0**, stamping tool contract
**53**, dynamicTool **51** and hook **24**. **eve 0.64.0 dropped all three at once**, while
`0.12.0`'s peer range `">=0.63.0"` still admits it. So
`npm install eve@latest @upstash/agentkit-eve-extension@latest` resolves cleanly, and then the first
`eve build` fails with the one-line error eve reports for a mount it cannot use:

```
Selected module binding "extensions/agentkit.ts" has no compile or runtime usage.
```

Nothing catches it earlier: the install is silent, and the error never mentions contracts, versions
or the extension package. `eve dev`, `eve eval` and `eve start` fail the same way. Verified on a fresh
consumer with eve 0.64.1 and 0.65.0 (the current `latest`).

The rebuilt dist stamps **tool 55 / dynamicTool 52 / hook 25** (`builtWithEve` 0.65.0). 0.65.0 is the
first eve accepting tool 55, so the peer moves `">=0.63.0"` → **`">=0.65.0"`** and an eve that cannot
run this dist is rejected at install (`ERESOLVE`) instead of failing at build time.

**No behaviour changed and no API changed**: the same extension source recompiled against a newer
eve. Every contribution is unchanged (`recall_memory` / `save_memory`, the dynamic `search` /
`search_aggregate` / `search_count` and `search_chat_history` / `read_chat_history` tools, the
`chat_history` hook and the memory instructions fragment), and the `zod: "^4.4.3"` range `0.12.0`
shipped for the dual-zod dedupe fix is kept.

If you are pinned to eve 0.63.0, stay on `0.12.0`.
