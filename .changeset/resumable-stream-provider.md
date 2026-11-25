---
"@upstash/agentkit-resumable-stream": minor
---

New package: an Upstash Redis provider for `resumable-stream`, over HTTP, so resumable AI SDK chat streams work on serverless and edge runtimes.

- `createResumableStreamContext`: `resumable-stream/generic` wired to Upstash Redis.
- `createUpstashPublisher` / `createUpstashSubscriber`: the generic `Publisher` and `Subscriber`. Messages larger than `maxMessageBytes` are split into ordered pieces, so a large replay is no longer lost to the request size limit, and publishes are queued per channel and sent in pipelines, so a resumed stream no longer waits one round trip per chunk.
- `createActiveStreamStore`: the active stream per chat, with an atomic compare-and-clear.
- `requestStop` / `createStopSignal`: stop a generation from any instance through an `AbortSignal`.
