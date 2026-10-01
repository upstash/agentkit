---
"@upstash/agentkit-tanstack-ai": patch
---

The telemetry header now reports the package's real version. 0.1.0 was built before its version constant was stamped, so it reported `0.0.0`.
