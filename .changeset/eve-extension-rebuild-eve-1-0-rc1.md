---
"@upstash/agentkit-eve-extension": minor
---

Rebuild the eve extension on eve 1.0.0-rc.1 and raise its `eve` peer floor to `>=1.0.0-rc.1`. The manifest records the eve version the dist was built with, and eve 0.91.x and older refuse a dist built with 1.0.0-rc.1 ("was built with eve 1.0.0-rc.1. Upgrade eve to 1.0.0-rc.1 or later"), so the previous `>=0.91.0 || >=1.0.0-0` range admitted versions that fail at `eve build`.
