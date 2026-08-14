---
"@upstash/agentkit-sdk": minor
"@upstash/agentkit-ai-sdk": minor
"@upstash/agentkit-eve": minor
"@upstash/agentkit-eve-extension": minor
---

feat: report the sdk name + version to Upstash via the redis client's telemetry headers

Every feature that takes a `redis` client now appends its package tag to the client's
`Upstash-Telemetry-Sdk` header (e.g.
`@upstash/redis@1.38.0,@upstash/agentkit-sdk@0.2.0,@upstash/agentkit-ai-sdk@0.2.0`), matching
`@upstash/ratelimit`. No personal data, keys or identifiers are collected. Opt out with
`enableTelemetry: false` on any config, with the same option on the redis client, or with the
`UPSTASH_DISABLE_TELEMETRY` env var.
