---
"@upstash/agentkit-tanstack-ai": patch
---

Fix a race in the `upstashPersistence()` log store's `subscribe`: a write from another machine that landed before the subscriber's first poll was treated as the starting point and never reported, so the listener could miss it. A watch now starts from the store's own last write to that log.
