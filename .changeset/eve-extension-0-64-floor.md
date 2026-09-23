---
"@upstash/agentkit-eve-extension": minor
---

fix!: rebuild the extension against `eve` 0.64.1 and raise the `eve` peer floor to `>=0.64.0` —
`0.11.0` cannot build on any eve released after it

`0.11.0` ships a `dist/extension/_manifest.json` built with eve 0.63.0, stamping tool contract **53**,
dynamicTool **51** and hook **24**. **eve 0.64.0 dropped all three at once** — its supported lists are
`tool` [1–13, 29–32, 34, 35, **54**], `dynamicTool` [1–20, 22, 31–33, **52**] and
`hook` [10–15, 17–23, **25**] — while `0.11.0`'s peer range `>=0.63.0` still admits it. So
`npm install eve@latest @upstash/agentkit-eve-extension@latest` resolves cleanly, and then the first
`eve build` fails with the manifest error eve reports for an unusable mount:

```
Selected module binding "extensions/agentkit.ts" has no compile or runtime usage.
```

Nothing catches it earlier: the install is silent, and `eve build` only checks the manifest — an
incompatible one makes the mount contribute nothing, which is why the error never mentions contracts
or versions.

The rebuilt dist stamps **tool 54 / dynamicTool 52 / hook 25** (`builtWithEve` 0.64.1) and the peer
moves `">=0.63.0"` → `">=0.64.0"`, so an eve that cannot run this dist is now rejected at install
instead of at build time. The boundary was measured, not read off the contract tables: the rebuilt
dist packed into real npm consumer apps **fails on eve 0.63.0 and builds on 0.64.0 and 0.64.1**. As
with every eve bump since ~0.50 there is no back-compat window — eve drops mid-range contracts rather
than only adding new ones, so the floor lands on the release that broke it.

**No behaviour changed and no API changed** — this is the same extension recompiled against a newer
eve, with the peer range corrected to match what the artifact can actually run on. Every contribution
is unchanged: the `recall_memory` / `save_memory` tools, the dynamic `search` / `search_aggregate` /
`search_count` and `search_chat_history` / `read_chat_history` tools, the `chat_history` hook and the
memory instructions fragment. Verified end to end on eve 0.64.1 against real Upstash Redis with the
committed mocked-model eval (`examples/eve-extension-demo`, 4/4 gates), which exercises a static tool
and a **dynamic** one in a real turn — the only thing that proves dynamic tools actually mounted,
since `eve build` never resolves them.

If you are pinned to eve 0.63.0, stay on `0.11.0`; it is the only eve release that version runs on.

`@upstash/agentkit-eve` is untouched and ships no release here: it stays pinned to eve `^0.63.0`
because eve 0.64.0 also removed the `SandboxBackend` API that `packages/eve/src/sandbox.ts`
implements, which needs a source rewrite against eve's new `eve/sandbox/provider` seam rather than a
version bump. Its own `eve` peer floor (`>=0.45.2`) remains correct.
