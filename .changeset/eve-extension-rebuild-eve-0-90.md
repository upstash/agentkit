---
"@upstash/agentkit-eve-extension": minor
---

Rebuild on eve 0.90.0 and raise the `eve` peer floor to `>=0.90.0`. The manifest records the eve version the dist was built with, and eve 0.85.0–0.89.x refuse a dist built with 0.90.0 ("was built with eve 0.90.0. Upgrade eve to 0.90.0 or later"), so the previous `>=0.85.0` floor admitted versions that fail at `eve build`.
