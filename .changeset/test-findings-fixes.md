---
"@upstash/agentkit-sdk": patch
"@upstash/agentkit-eve": patch
"@upstash/agentkit-eve-extension": patch
"@upstash/agentkit-tanstack-ai": patch
---

Fixes from testing the packages as a user would.

- **Index errors:** "no index slots left" names only old AgentKit indexes that exist; with none, it says to drop an index the database no longer uses. "exists with a different definition" no longer says to stop every client: the client that hit it retries on its next read.
- **Search tools:** a `noTokenize()` field is described to the model as an exact-value field, not fuzzy text.
- **TanStack AI:** `upstashPersistence()` without a `bucket` no longer returns an `artifacts` store, so `withGenerationPersistence()` works without Upstash Blob (TanStack needs `artifacts` and `blobs` together). `upstashMemory()` logs an index error once, since `memoryMiddleware` only reports recall errors to devtools. `upstashCredentials()` and `upstashMcpSessionStore()` warn when `encryptionKey` is passed as `undefined` (e.g. an unset env var), and a failed decrypt says the key is wrong or the entry was copied.
- **Eve:** `@upstash/agentkit-eve` no longer depends on `@upstash/agentkit-ai-sdk`, which it never imported. README import table names `UpstashSandbox`; the extension's `chatHistory.indexName` docs describe the shared index.
