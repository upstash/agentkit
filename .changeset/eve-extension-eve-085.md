---
"@upstash/agentkit-eve-extension": minor
---

Rebuild on eve 0.85.0 and migrate to the eve 0.84+ extension API, fixing `eve build` on eve 0.84.0 and later (the previous dist was rejected with "uses an old epoch-based distribution manifest"). The `eve` peer is now `>=0.85.0`: the new manifest records the eve version it was built with, and older eve releases refuse it. The chat-history hook now captures user text on `delivery.consumed` and assistant replies from `content.completed` (reply-phase text parts); the optional `userId` function receives the session `ctx` typed as `Pick<SessionFrame, "session">`.
