---
"@upstash/agentkit-sdk": minor
---

Add `createScriptRunner`, `lua`, `buildScript` and `isScriptFlagError`, which the adapter packages use to send their lua scripts with Upstash's `script_name` and `allow-key-locking` flags, and without them on servers which reject the flags.
