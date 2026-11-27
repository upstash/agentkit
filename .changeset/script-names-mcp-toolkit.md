---
"@upstash/mcp-toolkit": minor
---

`RedisTaskStore` and `RedisSubscriptionStore` name their lua scripts in Upstash's script stats (`mcp-toolkit-js-<script>`) and take `enableUpstashScriptFlags`. Unset, the scripts are sent with the `script_name` and `allow-key-locking` flags and, if the server rejects them, sent again without them after a one-time warning. `false` never sends the flags; `true` always does and throws on a rejection.
