---
"@upstash/agentkit-eve-extension": minor
---

chore: rebuild against eve 0.58.1 and raise the `eve` peer floor to `>=0.58.0`

No source changed. The extension's `dist` is rebuilt with **eve 0.58.1**, which re-stamps
`dist/extension/_manifest.json` relative to the published `0.10.0` build (eve 0.52.2):
**tool 30 → 45**, **dynamicTool 29 → 43**, **hook 20 → 22**, `builtWithEve` `0.52.2` → `0.58.1`.
`extension` 1, `instructions` 2 and `config` 1 are unchanged, and `formatVersion` stays 2. Every
compiled `.mjs` in `dist/` is byte-identical to `0.10.0`; besides the manifest, the only other
files that differ are five dynamic-tool `.d.ts` files (`tools/search.d.ts`,
`tools/search_aggregate.d.ts`, `tools/search_count.d.ts`, `tools/search_chat_history.d.ts`,
`tools/read_chat_history.d.ts`), where `DynamicSentinel` is now emitted as
`import("eve").DynamicSentinel` instead of `import("eve/tools").DynamicSentinel` — the same type,
re-exported from a different eve entrypoint.

**eve 0.58.0 is the oldest release accepting the new stamps**, so the `eve` peer moves
`">=0.52.2"` → `">=0.58.0"`. eve keeps *dropping* mid-range contracts, so a newer eve is not
automatically compatible: 0.57.0 tops out at tool 44 / dynamicTool 41, 0.56.0 at tool 43 /
dynamicTool 40, and 0.55.0 at tool 38 / dynamicTool 37. Verified by packing the rebuilt extension
into a real eve app: on eve 0.57.0 it installs and then fails `eve build` with
`Selected module binding "extensions/agentkit.ts" has no compile or runtime usage.`, while on
0.58.0 and 0.58.1 it builds and mounts all seven tools (`recall_memory`, `save_memory`, `search`,
`search_aggregate`, `search_count`, `search_chat_history`, `read_chat_history`) plus the
chat-history hook, with zero compiler diagnostics.

**This release still does not fix a break for anyone on the published `0.10.0`.** eve 0.58.1 keeps
supporting tool 30 / dynamicTool 29 / hook 20 (its `tool` list is [1–13, 28–32, 34, 35, 44, 45] and
its `hook` list [10–15, 17–22]), so the contracts published `0.10.0` requires are still accepted:
a scratch `npm install eve@latest @upstash/agentkit-eve-extension@latest
@upstash/agentkit-eve@latest` resolves eve 0.58.1 and `eve build` succeeds, mounting all seven
tools and the hook alongside a `defineMemoryRecallTool` tool from `@upstash/agentkit-eve`. This
release only keeps the stamps current; its one consumer-visible effect is that the raised floor
makes it unusable on any eve below 0.58.0, so anyone pinned to an older eve should stay on `0.10.0`.

**What this changeset originally described is now obsolete, and shipping it as written would have
broken consumers.** It previously targeted an eve 0.55.0 rebuild (tool 38 / dynamicTool 37, peer
`>=0.55.0`), which was never released. eve 0.56.0 *dropped* both of those contracts
("experimental_workflow and eve/tools/workflow were removed" for tool 36–39,
"workflowMaxSubagents was removed" for dynamicTool 35–38), so a 0.55.0-built dist published under a
`>=0.55.0` peer would install happily on eve 0.56.0–0.58.1 and then fail `eve build` on all of them.
The 0.58.1 stamps + `>=0.58.0` floor in this changeset replace that.

`@upstash/agentkit-eve` gets no release here: its `dist` is byte-identical (`diff -rq` over `.js`,
`.d.ts` and `.map`) to the published `0.9.0` after the bump, and its `eve` peer stays `>=0.32.0`
(re-verified by typechecking the built `dist` against eve 0.32.0 / 0.45.2 / 0.52.3 / 0.55.0 /
0.58.0 / 0.58.1 — all clean, `SandboxBackendHandle` needs no new member on 0.58.1). Only its
devDependency moved.
