---
"@upstash/agentkit-eve": patch
---

`UpstashSandbox` now works on eve 0.75 and later: the provider handle uses eve's renamed `onSandboxStop` / `onSandboxDelete` hooks (the old names are never called by eve 0.75+, so boxes were not paused or deleted). `setNetworkPolicy` is typed by the exported `UpstashSandboxSession`, since eve removed `MutableNetworkSandboxSession`. The `eve` peer floor is raised to `>=0.75.0`.
