---
"@upstash/agentkit-tanstack-ai": minor
---

Implement TanStack AI 1.0's three new backend contracts on Upstash Redis.

- `upstashPersistence()` now also returns a `sessions` store (`SessionIndexStore`): one entry per `(tenantId, threadId)` with members, title, usage and app metadata, newest-first `list` with filters and cursors, and a revision-checked `upsertIf`. `upstashSessionIndex` is exported from `/persistence` for standalone use.
- `upstashPersistence()` also returns a `log` store (`LogStore`, the append-only session log): atomic compare-and-append with consumed offers (at most 10,000 records per `append`), the epoch-fenced ownership lease, the input lane, snapshots, truncation and worker affinity, with the Redis server clock as the store clock. `subscribe` calls listeners right after writes through the same store and polls a change counter for writes from other machines (`logPollIntervalMs`, default 250). `upstashLogStore` is exported from `/persistence`.
- New `@upstash/agentkit-tanstack-ai/byok` entry: `upstashCredentials()`, a `CredentialStore` for provider API keys and OAuth tokens, with compare-and-set (`getVersioned` / `setIf`) and optional AES-256-GCM encryption at rest (`encryptionKey`, bound to the prefix, owner, id, type and expiry; `requireEncryption` refuses plaintext rows).

**Breaking for TanStack AI 0.x users:** the peer floors are raised, `@tanstack/ai` to `>=1.0.0` (the `/byok` types) and `@tanstack/ai-persistence` to `>=1.0.0` (the new store types appear in `upstashPersistence()`'s return type). Stay on `@upstash/agentkit-tanstack-ai@0.2.0` if you are not on TanStack AI 1.x yet. `@tanstack/ai-memory` is unchanged. `/persistence` now imports `@tanstack/ai-persistence` at runtime (the log store's error classes), so install it when you use that entry; `.`, `/memory` and `/byok` do not need it.
