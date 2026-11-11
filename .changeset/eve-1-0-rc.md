---
"@upstash/agentkit-eve": minor
"@upstash/agentkit-eve-extension": minor
---

Support eve 1.0 (built and tested against `eve@1.0.0-rc.9`).

**`@upstash/agentkit-eve-extension`:** the prebuilt extension is now built with eve 1.0.0-rc.9, and eve refuses an extension built with a newer eve than its own. The `eve` peer range is now `>=1.0.0-rc.9` (was `>=0.91.0 || >=1.0.0-0`), so installing on eve 0.x or on 1.0.0-rc.0 through rc.8 fails at install time instead of at `eve build`. If you are staying on eve 0.91, keep `@upstash/agentkit-eve-extension@0.19`.

**`@upstash/agentkit-eve`:** the `eve` peer range is unchanged (`>=0.87.0 || >=1.0.0-0`); this release is verified against eve 0.87.0, 0.91.0, 1.0.0-rc.0 and 1.0.0-rc.9. New tool activity labels:

- `redisMemory()` labels its slot tools, so channels show "Saving to memory", "Searching memory", "Forgetting a memory" and "Reading an earlier conversation" instead of the slot-prefixed tool name. These labels are fixed strings and never include the tool input. A new `toolLabels` option overrides them per tool. Set `toolLabels: false` (or `false` for one tool) to hide memory calls from channel activity, so an agent that follows a Slack thread quietly (`status: "deferred"`) can save or search memory and still end with `no_reply`.
- `defineMemoryRecallTool()` and `defineMemorySaveTool()` accept `label`, and `defineSearchTools()` accepts `labels` (one per tool).
- `false` labels need eve 1.0.0-rc.7 or later and only typecheck there.

On eve 1.0.0-rc.8 and later, `redisMemory()` tool calls also carry eve's `gen_ai.memory.store.id` trace attribute. Its value is the slot's scope key, the same key the Redis records are partitioned by. This needs no configuration.
