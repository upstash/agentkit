---
"@upstash/agentkit-eve-extension": patch
---

Rebuild against eve 0.83.0 and raise the `eve` peer floor to `>=0.83.0`. The compiled extension now declares tool contract 102, dynamicTool 92 and hook 51, which only eve 0.83.0 accepts (0.82.0 and earlier reject them; eve 0.83.0 also rejects the tool 96 / dynamicTool 88 / hook 48 stamps of an eve 0.82.0 build).
