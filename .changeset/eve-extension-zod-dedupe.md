---
"@upstash/agentkit-eve-extension": patch
---

fix: widen the `zod` dependency to `^4.4.3` so the search tools stop silently disappearing

**If you mount this extension with `search` configured, `0.11.0` almost certainly lost all three of its
search tools without telling you.** `agentkit__search`, `agentkit__search_aggregate` and
`agentkit__search_count` never got registered, so the agent simply behaved as though searching was not
available. `eve build` stayed green, the mount reported no error, and the extension's other
contributions (`recall_memory`, `save_memory`, the chat-history hook and the instructions fragment) kept
working — which made this look like a modelling or prompting problem rather than a broken install. The
only visible trace was a line in the server log at the start of every session:

```
[eve:dynamic-tools] Dynamic tool resolver (session.started) failed — skipping its complete result.
  { error: "Cannot read properties of undefined (reading 'push')" }
```

The cause was this package's own dependency range, not your app. `0.11.0` pinned `"zod": "4.4.3"`
**exactly**, while its sibling `@upstash/agentkit-sdk` asks for `"^3.23.8 || ^4"`. npm and pnpm both
satisfy those two ranges with **two different copies of zod**: the sdk gets whatever `zod@4` is current
(today 4.6.5) and this package gets its own nested 4.4.3. zod changed its internal schema
representation in **4.6.0**, so a schema object built by zod ≥4.6.0 cannot be read by zod <4.6.0. The
search tools build their input schemas through the sdk and then convert them with this package's zod, so
across two copies that conversion threw, the resolver failed, and eve dropped the tools.

The fix is one character of dependency metadata: `"zod": "4.4.3"` → **`"zod": "^4.4.3"`**. Normal
resolution now dedupes both packages onto a single shared zod instance and the conversion succeeds. No
source code, no API and no runtime behaviour changed — the same build output ships, and the extension
still requires zod 4.

You do not need to change anything in your app. Upgrade, reinstall so the tree dedupes, and the three
search tools come back. If you want to confirm it, a single turn that calls `agentkit__search_count` is
enough — and note that `eve build` succeeding never proved these tools were mounted, because eve only
resolves dynamic tools when a session starts.

This affected every consumer install regardless of package manager, and was invisible to this repo's own
test suite and CI: the workspace lockfile happens to resolve both packages to the same zod, so the
in-repo end-to-end eval passed while real installs were broken.
