---
"@upstash/agentkit-sdk": minor
"@upstash/agentkit-ai-sdk": minor
"@upstash/agentkit-eve": minor
"@upstash/agentkit-eve-extension": minor
"@upstash/agentkit-tanstack-ai": minor
---

Hybrid memory recall, and one search index for memory and chat history.

- **Hybrid recall:** memory `text` is now a Redis Search `HYBRID` field, and recall with a query merges keyword (`$smart`) and semantic (`$ann`) results with `$rrf`. Upstash Redis Search embeds the text itself. A query like "what should I cook?" now finds "The user is vegetarian." If a hybrid query fails, recall falls back to keyword once. `minScore` applies to keyword results only.
- **One index:** with default settings, `AgentMemory` and `ChatHistory` share one index, `agentkit`, over `agentkit:memory:` and `agentkit:chat:`, so they work on a database that allows only one index (Upstash's Free plan). It is the same index the Python package (`upstash-hermes-memory`) uses. A store with its own `prefix`, `indexName` or `metadataSchema` keeps its own index.
- Needs `@upstash/redis` 1.41.0 or later.

**Upgrading:** keys and documents are unchanged. Indexes created by earlier versions (`agentkit_memory`, `agentkit_chat`, and any custom memory index) have a `TEXT` field where a `HYBRID` one is now needed. A custom-prefix memory index that already exists fails with an error that says to run `SEARCH.DROP <index>`; documents are kept and indexed again on the next read. The default `agentkit_memory` and `agentkit_chat` indexes are no longer used and can be dropped.
