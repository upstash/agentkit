---
"@upstash/agentkit-tanstack-ai": minor
---

Name every lua script in Upstash's script stats (`script_name=agentkit-tanstack-ai-js-<script>`) and add `enableUpstashScriptFlags` to every store that runs scripts. Unset, the scripts are sent with the `script_name` and `allow-key-locking` flags and, if the server rejects them (Redis or Valkey outside Upstash), sent again without them after a one-time warning. `false` never sends the flags; `true` always does and throws on a rejection.
