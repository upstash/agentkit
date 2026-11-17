---
"@upstash/agentkit-sdk": minor
"@upstash/agentkit-ai-sdk": minor
"@upstash/agentkit-eve": minor
"@upstash/agentkit-eve-extension": minor
"@upstash/agentkit-tanstack-ai": minor
---

Hybrid memory recall, and one search index for memory and chat history.

- **Hybrid recall:** memory `text` is now a Redis Search `HYBRID` field, and recall with a query merges keyword (`$smart`) and semantic (`$ann`) results with `$rrf`. Upstash Redis Search embeds the text itself. A query like "what should I cook?" now finds "The user is vegetarian." `minScore` now switches recall to keyword only, above that BM25 floor: hybrid scores have no cutoff, so leave it unset for hybrid recall. If the server rejects a hybrid query, recall warns and uses keyword for that call.
- **One index:** with default settings, `AgentMemory` and `ChatHistory` share one index, `agentkit`, over `agentkit:memory:` and `agentkit:chat:`, so they work on a database that allows only one index (Upstash's Free plan). Chats are told apart from memories by `sessionId`, so chats saved by earlier versions are still listed and never recalled as memories. It is the same index the Python package (`upstash-hermes-memory`) uses. A store with its own `prefix`, `indexName` or `metadataSchema` keeps its own index.
- Needs `@upstash/redis` 1.41.0 or later.

**Upgrading:** keys and documents are unchanged; chats and memories saved by earlier versions are found by the new index. Indexes created by earlier versions (`agentkit_memory`, `agentkit_chat`, and any custom memory index) have a `TEXT` field where a `HYBRID` one is now needed:

- **Default settings:** `agentkit_memory` and `agentkit_chat` are no longer used. On a database with one index slot (Free plan), drop them with `SEARCH.DROP` before upgrading, or reads fail with an error that names them. Elsewhere they can be dropped any time.
- **Custom `prefix` / `indexName`:** the existing memory index fails with an error that says to run `SEARCH.DROP <index>`; documents are kept and indexed again on the next read.
- `createSearchTools` over an index you created yourself keeps working as before.
