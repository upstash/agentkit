# @upstash/agentkit-tanstack-ai

## 0.3.0

### Minor Changes

- d6216c0: Implement TanStack AI 1.0's three new backend contracts on Upstash Redis.

  - `upstashPersistence()` now also returns a `sessions` store (`SessionIndexStore`): one entry per `(tenantId, threadId)` with members, title, usage and app metadata, newest-first `list` with filters and cursors, and a revision-checked `upsertIf`. `upstashSessionIndex` is exported from `/persistence` for standalone use.
  - `upstashPersistence()` also returns a `log` store (`LogStore`, the append-only session log): atomic compare-and-append with consumed offers (at most 10,000 records per `append`), the epoch-fenced ownership lease, the input lane, snapshots, truncation and worker affinity, with the Redis server clock as the store clock. `subscribe` calls listeners right after writes through the same store and polls a change counter for writes from other machines (`logPollIntervalMs`, default 250). `upstashLogStore` is exported from `/persistence`.
  - New `@upstash/agentkit-tanstack-ai/byok` entry: `upstashCredentials()`, a `CredentialStore` for provider API keys and OAuth tokens, with compare-and-set (`getVersioned` / `setIf`) and optional AES-256-GCM encryption at rest (`encryptionKey`, bound to the prefix, owner, id, type and expiry; `requireEncryption` refuses plaintext rows).

  **Breaking for TanStack AI 0.x users:** the peer floors are raised, `@tanstack/ai` to `>=1.0.0` (the `/byok` types) and `@tanstack/ai-persistence` to `>=1.0.0` (the new store types appear in `upstashPersistence()`'s return type). Stay on `@upstash/agentkit-tanstack-ai@0.2.0` if you are not on TanStack AI 1.x yet. `@tanstack/ai-memory` is unchanged. `/persistence` now imports `@tanstack/ai-persistence` at runtime (the log store's error classes), so install it when you use that entry; `.`, `/memory` and `/byok` do not need it.

## 0.2.0

### Minor Changes

- bc59588: `upstashPersistence()` now includes an `activities` store (TanStack AI's `ActivityStore`): frontend-only AG-UI activity rows are persisted per thread in Redis, with the same TTL as the transcript, so they survive reloads and instance changes. It passes `@tanstack/ai-persistence` 0.10's conformance suite. Peer floors are raised to `@tanstack/ai` `>=0.65.0` and `@tanstack/ai-persistence` `>=0.8.0`.

## 0.1.1

### Patch Changes

- e526e5b: The telemetry header now reports the package's real version. 0.1.0 was built before its version constant was stamped, so it reported `0.0.0`.

## 0.1.0

### Minor Changes

- 1651ae2: New package: production backends for TanStack AI on Upstash Redis. `upstashPersistence()` covers every persistence store (messages, runs, interrupts, metadata, generation runs, artifacts, and with an Upstash Blob bucket, blobs) and passes TanStack's conformance suite with nothing skipped. Also `upstashStream()` (resumable `StreamDurability` on Redis Streams), `upstashLocks()` (distributed `LockStore`), `upstashMemory()` (a `MemoryAdapter` ranked in Redis Search, passing TanStack's memory contract), `toolCache()` and `rateLimit()` chat middlewares, and `createSearchTools()`. The Redis primitives underneath are exported too: `RedisLock` (a lease lock with fencing tokens) and `EventLog` (a resumable append-only log on Redis Streams).
