---
"@upstash/agentkit-eve": minor
---

Migrate to eve 0.87 and raise the `eve` peer floor to `>=0.87.0`. `redisMemory()` no longer registers the `compaction.completed` recall hook that eve 0.84 removed, which made `eve build` reject the whole slot ("provider.recall Unknown key compaction.completed"); `save_memory` now takes its ordering sequence from the turn that recalled, since eve's memory tools context no longer carries `turn`. `UpstashSandbox` implements eve's connection-based sandbox provider contract (`prepare` via `ctx.populate`, a byte-level `connection`, `onSessionEnd`): `start` is now an idempotent upsert keyed on the session id, `resume` throws eve's `SandboxSessionGoneError` when the box is gone, and a writable `stdin` is rejected. Apps on eve 0.84–0.86 should upgrade eve (their `./sandbox` and `./memory` entries were already broken on those versions).
