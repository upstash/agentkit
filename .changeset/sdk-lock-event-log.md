---
"@upstash/agentkit-sdk": minor
---

Add `RedisLock` (lease lock with fencing tokens, ownership-checked release/extend, background renewal that aborts on loss) and `EventLog` (resumable append-only log on Redis Streams with atomic batch appends, resume-after-offset, close + drain, and snapshot).
