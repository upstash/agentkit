---
"@upstash/agentkit-eve-extension": patch
---

Rebuild on eve ≥0.25's dist packaging format (`eve.extension.source`/`.dist`, prebuilt `dist/extension` + compatibility manifest, dist-only tarball). Fixes installing the extension from npm: eve 0.25 rejects the old source-recompile format outright, and the prebuilt dist also removes the need to install `@upstash/agentkit-sdk` alongside the extension. Consumers need eve ≥0.25.2; apps that configure `search` also declare `@upstash/redis` themselves (their own mount file imports the `s` schema builder from it — a mount without `search` needs no extra installs).
