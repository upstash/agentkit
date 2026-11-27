# @upstash/agentkit-tanstack-ai

## 0.5.0

### Minor Changes

- dae29d8: Name every lua script in Upstash's script stats (`script_name=agentkit-tanstack-ai-js-<script>`) and add `enableUpstashScriptFlags` to every store that runs scripts. Unset, the scripts are sent with the `script_name` and `allow-key-locking` flags and, if the server rejects them (Redis or Valkey outside Upstash), sent again without them after a one-time warning. `false` never sends the flags; `true` always does and throws on a rejection.

### Patch Changes

- Updated dependencies [dae29d8]
  - @upstash/agentkit-sdk@0.21.0

## 0.4.0

### Minor Changes

- 4b04fc0: Hybrid memory recall, and one search index for memory and chat history.

  - **Hybrid recall:** memory `text` is now a Redis Search `HYBRID` field, and recall with a query merges keyword (`$smart`) and semantic (`$ann`) results with `$rrf`. Upstash Redis Search embeds the text itself. A query like "what should I cook?" now finds "The user is vegetarian." `minScore` now switches recall to keyword only, above that BM25 floor: hybrid scores have no cutoff, so leave it unset for hybrid recall. If the server rejects a hybrid query, recall warns and uses keyword for that call.
  - **One index:** with default settings, `AgentMemory` and `ChatHistory` share one index, `agentkit`, over `agentkit:memory:` and `agentkit:chat:`, so they work on a database that allows only one index (Upstash's Free plan). Chats are told apart from memories by `sessionId`, so chats saved by earlier versions are still listed and never recalled as memories. It is the same index the Python package (`upstash-hermes-memory`) uses. A store with its own `prefix`, `indexName` or `metadataSchema` keeps its own index.
  - Needs `@upstash/redis` 1.41.0 or later.

  **Upgrading:** keys and documents are unchanged; chats and memories saved by earlier versions are found by the new index. Indexes created by earlier versions (`agentkit_memory`, `agentkit_chat`, and any custom memory index) have a `TEXT` field where a `HYBRID` one is now needed:

  - **Default settings:** `agentkit_memory` and `agentkit_chat` are no longer used. On a database with one index slot (Free plan), drop them with `SEARCH.DROP` before upgrading, or reads fail with an error that names them. Elsewhere they can be dropped any time.
  - **Custom `prefix` / `indexName`:** the existing memory index fails with an error that says to run `SEARCH.DROP <index>`; documents are kept and indexed again on the next read.
  - `createSearchTools` over an index you created yourself keeps working as before.

- b64f89f: Add stores for TanStack AI's sandbox and MCP packages, all on Upstash Redis.

  - `@upstash/agentkit-tanstack-ai/sandbox` (needs `@tanstack/ai-sandbox` >= 1.0.0):
    - `upstashSandboxCheckpointStore()` is a `SandboxCheckpointStore` for portable sandbox snapshots. It supports `forkFromCheckpoint`, which branches a thread, files and transcript included.
    - `upstashSandboxInstanceStore()` lets any server resume a thread's sandbox.
    - Both pass TanStack's sandbox conformance suites.
  - `@upstash/agentkit-tanstack-ai/mcp` (needs `@tanstack/ai-mcp` >= 1.0.0):
    - `upstashMcpTaskStore()` is the `taskStore` for `createMCPServer`.
    - `upstashMcpEventStore()` stores MCP Events webhook subscriptions, shared across instances.
    - `upstashMcpSessionStore()` is the `McpSessionStore` for MCP Apps.
      - The JSON part of each server descriptor is stored in Redis. With `encryptionKey`, each stored entry is encrypted.
      - Functions such as `needsApproval` come back through your `resolve` callback.
      - It fails closed: it returns `null` rather than a descriptor that lost its approval gate.
  - `upstashPersistence({ bucket })` is now typed with a required `blobs` store, so you can pass it straight to `createSandboxSnapshots()`.

### Patch Changes

- b64f89f: Fix a race in the `upstashPersistence()` log store's `subscribe`: a write from another machine that landed before the subscriber's first poll was treated as the starting point and never reported, so the listener could miss it. A watch now starts from the store's own last write to that log.
- Updated dependencies [4b04fc0]
  - @upstash/agentkit-sdk@0.20.0

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
