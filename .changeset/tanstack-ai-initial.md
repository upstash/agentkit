---
"@upstash/agentkit-tanstack-ai": minor
---

New package: production backends for TanStack AI on Upstash Redis. `upstashPersistence()` covers every persistence store (messages, runs, interrupts, metadata, generation runs, artifacts, and with an Upstash Blob bucket, blobs) and passes TanStack's conformance suite with nothing skipped. Also `upstashStream()` (resumable `StreamDurability` on Redis Streams), `upstashLocks()` (distributed `LockStore`), `upstashMemory()` (a `MemoryAdapter` ranked in Redis Search, passing TanStack's memory contract), `toolCache()` and `rateLimit()` chat middlewares, and `createSearchTools()`. The Redis primitives underneath are exported too: `RedisLock` (a lease lock with fencing tokens) and `EventLog` (a resumable append-only log on Redis Streams).
