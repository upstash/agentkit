---
"@upstash/agentkit-tanstack-ai": minor
---

Implement TanStack AI 1.0's two new backend contracts on Upstash Redis.

- `upstashPersistence()` now also returns a `sessions` store (`SessionIndexStore`): one entry per `(tenantId, threadId)` with members, title, usage and app metadata, newest-first `list` with filters and cursors, and a revision-checked `upsertIf`. `upstashSessionIndex` is exported from `/persistence` for standalone use.
- New `@upstash/agentkit-tanstack-ai/byok` entry: `upstashCredentials()`, a `CredentialStore` for provider API keys and OAuth tokens, with compare-and-set (`getVersioned` / `setIf`) and optional AES-256-GCM encryption at rest (`encryptionKey`).

**Peer floors raised:** `@tanstack/ai` to `>=1.0.0` (the `/byok` types) and `@tanstack/ai-persistence` to `>=1.0.0` (the `SessionIndexStore` type now appears in `upstashPersistence()`'s return type). `@tanstack/ai-memory` is unchanged.
