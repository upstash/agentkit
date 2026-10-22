---
"@upstash/agentkit-eve-extension": patch
---

Rebuild against eve 0.82.0 and raise the `eve` peer floor to `>=0.82.0`. The compiled extension now declares tool contract 96, dynamicTool 88 and hook 48, which only eve 0.82.0 accepts (0.75.0–0.81.1 reject them).
