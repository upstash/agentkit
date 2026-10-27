# @upstash/agentkit-tanstack-ai

## 0.2.0

### Minor Changes

- bc59588: `upstashPersistence()` now includes an `activities` store (TanStack AI's `ActivityStore`): frontend-only AG-UI activity rows are persisted per thread in Redis, with the same TTL as the transcript, so they survive reloads and instance changes. It passes `@tanstack/ai-persistence` 0.10's conformance suite. Peer floors are raised to `@tanstack/ai` `>=0.65.0` and `@tanstack/ai-persistence` `>=0.8.0`.

## 0.1.1

### Patch Changes

- e526e5b: The telemetry header now reports the package's real version. 0.1.0 was built before its version constant was stamped, so it reported `0.0.0`.

## 0.1.0

### Minor Changes

- 1651ae2: New package: production backends for TanStack AI on Upstash Redis. `upstashPersistence()` covers every persistence store (messages, runs, interrupts, metadata, generation runs, artifacts, and with an Upstash Blob bucket, blobs) and passes TanStack's conformance suite with nothing skipped. Also `upstashStream()` (resumable `StreamDurability` on Redis Streams), `upstashLocks()` (distributed `LockStore`), `upstashMemory()` (a `MemoryAdapter` ranked in Redis Search, passing TanStack's memory contract), `toolCache()` and `rateLimit()` chat middlewares, and `createSearchTools()`. The Redis primitives underneath are exported too: `RedisLock` (a lease lock with fencing tokens) and `EventLog` (a resumable append-only log on Redis Streams).
