---
"upstash-hermes-memory": minor
---

**Breaking:** memory and chat history now share one Redis Search index (`agentkit`, over `agentkit:memory:` and `agentkit:chat:`), so the provider works on Upstash's Free plan, which allows one index per database. Before, it created two (`agentkit_memory` and `agentkit_chat`) and failed with `ERR Exceeded max index count of 1`. `UPSTASH_HERMES_NAMESPACE` replaces `UPSTASH_HERMES_MEMORY_PREFIX` and `UPSTASH_HERMES_CHAT_PREFIX`. Chats saved before this change are not found by the new index; memories keep their keys and shape and are still shared with AgentKit TS apps.
