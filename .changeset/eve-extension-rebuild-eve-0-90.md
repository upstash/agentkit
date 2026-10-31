---
"@upstash/agentkit-eve-extension": minor
"@upstash/agentkit-eve": patch
---

Rebuild the eve extension on eve 0.91.0 and raise its `eve` peer floor to `>=0.91.0`. The manifest records the eve version the dist was built with, and eve 0.90.x and older refuse a dist built with 0.91.0 ("was built with eve 0.91.0. Upgrade eve to 0.91.0 or later"), so the previous `>=0.85.0` floor admitted versions that fail at `eve build`.

Both `eve` peer ranges now also admit eve 1.0 prereleases (`|| >=1.0.0-0`). semver never matches a prerelease against `>=0.x`, so `npm install eve@latest` (now `1.0.0-rc.1`) failed with ERESOLVE against `@upstash/agentkit-eve` and `@upstash/agentkit-eve-extension`. A dist built on 0.91.0 builds cleanly on `eve@1.0.0-rc.1`.
