# upstash-hermes-memory

## 0.2.0

### Minor Changes

- 0b64d2d: **Breaking:** memory and chat history now share one Redis Search index (`agentkit`, over `agentkit:memory:` and `agentkit:chat:`), so the provider works on Upstash's Free plan, which allows one index per database. Before, it created two (`agentkit_memory` and `agentkit_chat`) and failed with `ERR Exceeded max index count of 1`. `UPSTASH_HERMES_NAMESPACE` replaces `UPSTASH_HERMES_MEMORY_PREFIX` and `UPSTASH_HERMES_CHAT_PREFIX`. Chats saved before this change are not found by the new index; memories keep their keys and shape and are still shared with AgentKit TS apps.

### Patch Changes

- 0b64d2d: Mirror corrections and removals from the built-in `memory` tool: when Hermes replaces, patches or removes an entry, the copy mirrored to Redis is deleted (and a replace saves the new text), so a corrected or deleted fact is no longer recalled.

## 0.1.1

### Patch Changes

- 7822958: Prepare for the Hermes plugin catalog: add `plugin.yaml` and a directory `__init__.py`, cap
  `upstash-redis` below 2, and document telemetry and how to turn it off.

## 0.1.0

### Minor Changes

- 6269e3b: First release: an Upstash Redis memory provider for Hermes Agent. It recalls related memories into each turn, saves every session as a searchable transcript, mirrors the built-in `memory` tool, and gives the model `upstash_memory_save` / `_search` / `_forget` and `upstash_chat_search`. It reads and writes the same keys and Redis Search indexes as `AgentMemory` and `ChatHistory` in `@upstash/agentkit-sdk`, so memories are shared with AgentKit apps on the same database.
