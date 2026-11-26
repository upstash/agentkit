---
"@upstash/agentkit-eve": minor
---

`redisDocuments()` names its compare-and-set lua script in Upstash's script stats (`agentkit-eve-js-memory_document_cas`) and takes `enableUpstashScriptFlags`. Unset, the script is sent with the `script_name` and `allow-key-locking` flags and, if the server rejects them, sent again without them after a one-time warning. `false` never sends the flags; `true` always does and throws on a rejection.
