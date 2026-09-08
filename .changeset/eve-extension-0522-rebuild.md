---
"@upstash/agentkit-eve-extension": minor
---

fix!: rebuild against eve 0.52.2 and raise the `eve` peer floor to `>=0.52.2`

The extension is now built with **eve 0.52.2**, whose
`dist/extension/_manifest.json` stamps formatVersion 2 and contracts
extension 1 / **tool 30** / **dynamicTool 29** / **hook 20** / instructions 2 /
config 1 — up from **tool 24 / dynamicTool 21 / hook 16** in the published `0.9.0`
build (eve 0.49.0). All three moving contracts advanced this time.

**This release fixes a real break in `0.9.0`.** eve 0.50.0 and every release above
it *dropped* the contracts the published dist requires, so `0.9.0` installs cleanly
against its `">=0.48.0"` peer and then fails `eve build` with
`Selected module binding "extensions/agentkit.ts" has no compile or runtime usage.`
Anyone on eve ≥0.50.0 needs this version.

eve 0.52.2 is the only release whose `EXTENSION_CAPABILITY_CONTRACTS` accept the new
stamps (0.52.0/0.52.1 top out at tool 29, 0.51.1 at tool 27, 0.51.0 at tool 25 /
hook 18, 0.50.0 at dynamicTool 22 / hook 17), so the `eve` peer moves from
`">=0.48.0"` to `">=0.52.2"`. Verified by packing the rebuilt extension into a real
eve app: on eve 0.52.1 it installs cleanly and then fails `eve build` with the message
above, while eve 0.52.2 builds and mounts all seven tools plus the chat-history hook.

Note that eve now **drops** contracts out of the middle of its supported range rather
than only adding new ones — 0.52.2 supports `tool` [1–13, 28, 29, 30] and drops 14–27.
A newer eve is therefore no longer automatically compatible, and a floored peer with no
ceiling is not by itself a guarantee; always re-derive the floor from the freshly built
manifest.

No extension source changed: the `chat_history` hook subscribes only to
`message.received`/`message.completed` (not the append events cited in eve's drop
reasons), and nothing here uses `TaskExec.delegated`. All packages build, typecheck and
pass their tests against eve 0.52.2, and the demo's mocked-model eval is green.
