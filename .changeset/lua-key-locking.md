---
"@upstash/agentkit-eve": patch
---

`redisDocuments()` now runs its compare-and-swap Lua script with the `allow-key-locking` flag, so Upstash locks only the document's key instead of the whole database while the script runs.
