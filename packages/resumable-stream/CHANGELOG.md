# @upstash/agentkit-resumable-stream

## 0.1.0

### Minor Changes

- ed4f123: New package: an Upstash Redis provider for `resumable-stream`, over HTTP, so resumable AI SDK chat streams work on serverless and edge runtimes.

  - `createUpstashPublisher` / `createUpstashSubscriber`: the `Publisher` and `Subscriber` to pass to `createResumableStreamContext` from `resumable-stream/generic`. Large messages are split into ordered pieces, so a large replay is not lost to the request size limit, and publishes are queued per channel and sent in pipelines, so a resumed stream does not wait one round trip per chunk.
  - `requestStop` / `createStopSignal`: stop a generation from any instance through an `AbortSignal`.
