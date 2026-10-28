# upstash-hermes-memory

## 0.1.0

### Minor Changes

- 6269e3b: First release: an Upstash Redis memory provider for Hermes Agent. It recalls related memories into each turn, saves every session as a searchable transcript, mirrors the built-in `memory` tool, and gives the model `upstash_memory_save` / `_search` / `_forget` and `upstash_chat_search`. It reads and writes the same keys and Redis Search indexes as `AgentMemory` and `ChatHistory` in `@upstash/agentkit-sdk`, so memories are shared with AgentKit apps on the same database.
