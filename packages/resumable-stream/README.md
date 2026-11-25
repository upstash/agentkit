# @upstash/agentkit-resumable-stream

An [Upstash Redis](https://upstash.com/) provider for
[`resumable-stream`](https://github.com/vercel/resumable-stream), the library behind the AI SDK's
[Chatbot Resume Streams](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams) flow. It runs
over HTTP, so it works on serverless and edge runtimes where a TCP Redis client does not, and it adds
the two pieces the resume flow leaves to you: a registry of the active stream per chat, and a stop
button that works across instances.

- **`createResumableStreamContext`**: `resumable-stream/generic`'s context, wired to Upstash.
- **`createUpstashPublisher` / `createUpstashSubscriber`**: the `Publisher` and `Subscriber` that
  `resumable-stream/generic` asks for, on `@upstash/redis`.
- **`createActiveStreamStore`**: which stream is active for each chat, with an atomic
  compare-and-clear.
- **`requestStop` / `createStopSignal`**: stop a generation from any instance; the producer gets an
  `AbortSignal` for `streamText({ abortSignal })`.

## Install

```bash
npm install @upstash/agentkit-resumable-stream resumable-stream
```

`resumable-stream` (2.2.10 or later) is a peer dependency. Set `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN`; every function defaults to `Redis.fromEnv()` and takes a `redis` client
to override it.

## Next.js App Router

The AI SDK flow, with Upstash for the streams, the active-stream record and the stop. The client is
the AI SDK's: `useChat({ id, resume: true })`, with a stop button that calls the stop route.

```ts
// lib/streams.ts
import { after } from "next/server";
import {
  createActiveStreamStore,
  createResumableStreamContext,
} from "@upstash/agentkit-resumable-stream";

export const streamContext = createResumableStreamContext({ waitUntil: after });
export const activeStreams = createActiveStreamStore();
```

```ts
// app/api/chat/route.ts: POST creates the stream
import { openai } from "@ai-sdk/openai";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  generateId,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { createStopSignal } from "@upstash/agentkit-resumable-stream";
import { activeStreams, streamContext } from "@/lib/streams";
import { readChat, saveChat } from "@/lib/chat-store"; // your message storage

export async function POST(req: Request) {
  const { id, message }: { id: string; message: UIMessage } = await req.json();
  const messages = [...(await readChat(id)), message];

  const streamId = generateId();
  // Aborts when /api/chat/[id]/stop is called, on whichever instance it lands.
  const stop = createStopSignal(streamId);

  const result = streamText({
    model: openai("gpt-5.4-mini"),
    messages: await convertToModelMessages(messages),
    abortSignal: stop.signal,
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      originalMessages: messages,
      generateMessageId: generateId,
      onEnd: async ({ messages }) => {
        stop.dispose();
        await saveChat(id, messages);
        // Only if it still points at this stream: a newer one may have started.
        await activeStreams.clear(id, streamId);
      },
    }),
    async consumeSseStream({ stream }) {
      await activeStreams.set(id, streamId);
      await streamContext.createNewResumableStream(streamId, () => stream);
    },
  });
}
```

```ts
// app/api/chat/[id]/stream/route.ts: GET resumes it (useChat calls this on mount)
import { UI_MESSAGE_STREAM_HEADERS } from "ai";
import { activeStreams, streamContext } from "@/lib/streams";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const streamId = await activeStreams.get(id);
  if (!streamId) return new Response(null, { status: 204 });

  const stream = await streamContext.resumeExistingStream(streamId);
  // null: finished; undefined: expired or never started.
  if (!stream) return new Response(null, { status: 204 });
  return new Response(stream, { headers: UI_MESSAGE_STREAM_HEADERS });
}
```

```ts
// app/api/chat/[id]/stop/route.ts: POST stops it, from any instance
import { requestStop } from "@upstash/agentkit-resumable-stream";
import { activeStreams } from "@/lib/streams";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { activeStreamId } = (await req.json().catch(() => ({}))) as { activeStreamId?: string };
  const streamId = await activeStreams.get(id);
  if (!streamId || (activeStreamId && activeStreamId !== streamId)) {
    return Response.json({ success: true }); // nothing running, or a stale stop
  }
  await requestStop(streamId);
  await activeStreams.clear(id, streamId);
  return Response.json({ success: true });
}
```

A stopped `streamText` ends its stream, so `onEnd` still runs (with `isAborted: true`) and saves the
partial answer, and every resumed reader sees the stream finish.

## API

### `createResumableStreamContext(options)`

Returns resumable-stream's `ResumableStreamContext` (`resumableStream`, `createNewResumableStream`,
`resumeExistingStream`, `hasExistingStream`).

```ts
createResumableStreamContext({
  waitUntil: after, // required: after / waitUntil, or null on a long-running server
  redis, // optional: Upstash client, default Redis.fromEnv()
  keyPrefix, // optional: default "resumable-stream"
  doneWatchdogIntervalMs, // optional: passed to resumable-stream
  publisherOptions, // optional: see createUpstashPublisher
  subscriberOptions, // optional: see createUpstashSubscriber
  publisher, // optional: your own Publisher instead
  subscriber, // optional: your own Subscriber instead
  enableTelemetry, // optional: default true
});
```

### `createUpstashPublisher(redis?, options?)` / `createUpstashSubscriber(redis?, options?)`

The generic `Publisher` and `Subscriber`, for when you call `resumable-stream/generic` yourself. Use
them together: messages travel in a small JSON envelope that the subscriber unwraps.

```ts
import { createResumableStreamContext } from "resumable-stream/generic";
import { createUpstashPublisher, createUpstashSubscriber } from "@upstash/agentkit-resumable-stream";

const streamContext = createResumableStreamContext({
  waitUntil: after,
  publisher: createUpstashPublisher(redis, {
    maxMessageBytes: 256 * 1024, // optional: split larger messages into pieces
    maxBatchBytes: 1024 * 1024, // optional: cap on one pipeline request
    batch: true, // optional: queue publishes per channel and send them in pipelines
    onError: (error, channel) => {}, // optional: a queued publish failed
  }),
  subscriber: createUpstashSubscriber(redis, {
    subscribeTimeoutMs: 10_000, // optional: wait this long for Upstash to confirm a subscription
    onError: (error, channel) => {}, // optional
  }),
});
```

What they do beyond a plain mapping of commands:

- **Large messages are split.** When a client resumes, resumable-stream publishes everything
  buffered so far as one message. Past the plan's max request size Upstash rejects it, and the
  resumed client silently misses that part of the answer
  ([vercel/resumable-stream#55](https://github.com/vercel/resumable-stream/issues/55)). The publisher
  splits any message over `maxMessageBytes` into ordered pieces on the same channel. The listener
  enqueues each message as it arrives, so the reader gets the same text in more chunks. Pieces never
  split a surrogate pair and never equal resumable-stream's DONE message.
- **Publishes are batched.** The producer awaits each publish before it reads the next chunk, so
  over HTTP a resumed stream would advance one chunk per round trip
  ([vercel/resumable-stream#52](https://github.com/vercel/resumable-stream/issues/52)). With `batch`
  (the default), a publish is queued per channel and resolves at once; the queue sends what
  accumulates as one pipeline request at a time, in order. The DONE message waits until everything
  queued before it on its channel is sent, so `waitUntil` covers the whole flush. A failed send calls
  `onError` (default `console.error`), and that channel's later publishes and its DONE reject with the
  error.
- **Subscriptions are confirmed.** Upstash serves SUBSCRIBE as a Server-Sent Events response, one
  open HTTP request per channel. `subscribe` resolves only once Upstash confirms the subscription,
  because resumable-stream publishes right after it. `unsubscribe` aborts the request, which ends
  the subscription on the server.
- **Messages keep their text.** `@upstash/redis` JSON-parses subscription messages and splits its
  event stream on newlines; the envelope survives both, so a chunk such as `"42"` or one full of
  newlines arrives unchanged.

Stream ids cannot contain a comma: `@upstash/redis` parses `message,<channel>,<message>`, so
`subscribe` rejects such a channel instead of misrouting it.

### `createActiveStreamStore(config?)`

```ts
const activeStreams = createActiveStreamStore({
  redis, // optional: default Redis.fromEnv()
  prefix: "agentkit:activeStream", // optional: key is `<prefix>:<chatId>`
  ttlSeconds: 86400, // optional: matches resumable-stream's own 24 hours
});

await activeStreams.set(chatId, streamId); // replaces any previous stream
await activeStreams.get(chatId); // string | null
await activeStreams.clear(chatId, streamId); // true if it still pointed at streamId and was removed
```

`clear` is one Lua script (compare and delete), so a stream that finishes after a newer one started
for the same chat cannot clear the newer one.

### `requestStop(streamId, options?)` / `createStopSignal(streamId, options?)`

```ts
// Producer: pass the signal to the work, dispose when it ends.
const stop = createStopSignal(streamId, {
  redis, // optional
  prefix: "agentkit:stop", // optional: key is `<prefix>:<streamId>`
  pollIntervalMs: 1000, // optional: how often to check
  signal: req.signal, // optional: also abort when this aborts
  onError: (error) => {}, // optional: a check failed; polling continues
});
streamText({ model, messages, abortSignal: stop.signal });
stop.dispose();

// Anywhere: ask it to stop.
await requestStop(streamId, { redis, prefix, ttlSeconds: 3600 }); // all optional
```

The signal aborts with a `StopRequestedError` (with `streamId`). It polls a key instead of
subscribing: a held-open SUBSCRIBE per producer would react sooner, but over HTTP it is lost
silently if its request drops, while a poll has a fixed cost and cannot miss a stop that is already
set. A stop takes effect within about one `pollIntervalMs` plus a round trip.

## Cost

Every Upstash command counts, including each command inside a pipeline; pipelines save round trips,
not commands.

| What | Commands |
| --- | --- |
| Start a stream (`createNewResumableStream`) | SUBSCRIBE (one HTTP request held open until the stream ends) + SET; SET when it ends. `resumableStream` adds an INCR. |
| A stream nobody resumes | Nothing per chunk: chunks are only published to resumed readers. |
| Resume (`resumeExistingStream`) | GET + SUBSCRIBE + PUBLISH (the request). The producer then sends the replay (one PUBLISH per piece of `maxMessageBytes`), one PUBLISH per later chunk, and the DONE message. |
| A resumed reader while it waits | One GET per `doneWatchdogIntervalMs` (10 s by default; resumable-stream's lost-DONE check). |
| `createStopSignal` | One EXISTS at start, then `1000 / pollIntervalMs` per second while the producer runs: 1 per second by default, so a 30-second answer costs about 31. |
| `requestStop`, `activeStreams.set` / `get` / `clear` | One command each. |

## Telemetry

The package reports its name and version on the requests of the redis client it is given (the
`Upstash-Telemetry-Sdk` header), like the other AgentKit packages. No personal data is sent. Opt out
with `enableTelemetry: false`, the same option on the redis client, or the
`UPSTASH_DISABLE_TELEMETRY` environment variable.

## License

MIT
