---
"@upstash/agentkit-tanstack-ai": minor
---

`upstashPersistence()` now includes an `activities` store (TanStack AI's `ActivityStore`): frontend-only AG-UI activity rows are persisted per thread in Redis, with the same TTL as the transcript, so they survive reloads and instance changes. It passes `@tanstack/ai-persistence` 0.10's conformance suite. Peer floors are raised to `@tanstack/ai` `>=0.65.0` and `@tanstack/ai-persistence` `>=0.8.0`.
