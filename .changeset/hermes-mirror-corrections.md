---
"upstash-hermes-memory": patch
---

Mirror corrections and removals from the built-in `memory` tool: when Hermes replaces, patches or removes an entry, the copy mirrored to Redis is deleted (and a replace saves the new text), so a corrected or deleted fact is no longer recalled.
