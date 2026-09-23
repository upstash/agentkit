---
"@upstash/agentkit-eve-extension": minor
---

fix!: rebuild the extension against `eve` 0.64.1 and raise the `eve` peer floor to `>=0.64.0` —
`0.12.0` cannot build on any eve released after it

`0.12.0` ships a `dist/extension/_manifest.json` built with **eve 0.63.0**, stamping tool contract
**53**, dynamicTool **51** and hook **24**. **eve 0.64.0 dropped all three at once** — its supported
lists are `tool` [1–13, 29–32, 34, 35, **54**], `dynamicTool` [1–20, 22, 31–33, **52**] and `hook`
[10–15, 17–23, **25**] — while `0.12.0`'s peer range `">=0.63.0"` still admits it. So
`npm install eve@latest @upstash/agentkit-eve-extension@latest` resolves cleanly, and then the first
`eve build` fails with the one-line manifest error eve reports for a mount it cannot use:

```
Selected module binding "extensions/agentkit.ts" has no compile or runtime usage.
```

Nothing catches it earlier: the install is silent, and the error never mentions contracts, versions
or even the extension package — an incompatible manifest simply makes the mount contribute nothing,
and eve reports the empty binding that results. `eve dev`, `eve eval` and `eve start` fail the same
way, so the agent never starts at all.

The rebuilt dist stamps **tool 54 / dynamicTool 52 / hook 25** (`builtWithEve` 0.64.1) and the peer
moves `">=0.63.0"` → **`">=0.64.0"`**, so an eve that cannot run this dist is rejected at install
instead of at build time. The boundary was measured, not read off the contract tables: the rebuilt
dist packed into a real npm consumer app **fails on eve 0.63.0 and builds on 0.64.0 and 0.64.1**. As
with every eve bump since ~0.50 there is no back-compat window — eve drops mid-range contracts rather
than only adding new ones, so the floor lands on the release that broke it.

**No behaviour changed and no API changed** — this is the same extension source recompiled against a
newer eve, with the peer range corrected to match what the artifact can actually run on. Every
contribution is unchanged: the `recall_memory` / `save_memory` tools, the dynamic `search` /
`search_aggregate` / `search_count` and `search_chat_history` / `read_chat_history` tools, the
`chat_history` hook and the memory instructions fragment. The `zod: "^4.4.3"` dependency range that
`0.12.0` shipped to fix the dual-zod dedupe bug is **kept as-is** — the search tools still resolve
onto a single shared zod instance.

Verified from a real consumer's point of view, not just from this repo: the packed tarball installed
with `npm` alongside `eve@0.64.1` and `@upstash/agentkit-eve`, mounted with a `search` config, builds
clean and — in a real session — mounts all five dynamic tools plus both memory tools. That last part
is the check that matters: `eve build` never resolves dynamic tools, so only a turn that sees them
proves they mounted.

If you are pinned to eve 0.63.0, stay on `0.12.0`; it is the only eve release that version runs on.

`@upstash/agentkit-eve` is untouched and ships no release here. It stays pinned to eve `^0.63.0`
because eve 0.64.0 also removed the `SandboxBackend*` authoring types that `packages/eve/src/sandbox.ts`
implements (they were replaced by a new `eve/sandbox/provider` / `defineSandboxProvider` seam), which
needs a source migration rather than a version bump. Its own `eve` peer floor (`>=0.45.2`) remains
correct and is unchanged.
