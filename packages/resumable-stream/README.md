# @upstash/agentkit-resumable-stream

An [Upstash Redis](https://upstash.com/) provider for
[`resumable-stream`](https://github.com/vercel/resumable-stream), the library behind the AI SDK's
[Chatbot Resume Streams](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams). It talks to
Redis over HTTP, so it works on serverless and edge runtimes, and adds a stop signal that works
across instances.

```bash
npm install @upstash/agentkit-resumable-stream resumable-stream
```

`resumable-stream` 2.2.10 or later is a peer dependency. Set `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN`; every function defaults to `Redis.fromEnv()`.

## Next.js App Router

The AI SDK flow. `readChat`/`saveChat` are your chat storage; keep `activeStreamId` on the chat
record, as the AI SDK docs do. The client is `useChat({ id, resume: true })`.

```ts
// app/api/chat/route.ts: POST creates the stream
import { convertToModelMessages, createUIMessageStreamResponse, generateId, streamText, toUIMessageStream } from "ai";
import { after } from "next/server";
import { createResumableStreamContext, createStopSignal } from "@upstash/agentkit-resumable-stream";

export async function POST(req: Request) {
  const { id, message } = await req.json();
  const messages = [...(await readChat(id)).messages, message];
  const streamId = generateId();
  const stop = createStopSignal(streamId); // aborts when the stop route is called, on any instance

  const result = streamText({
    model: "openai/gpt-5.4-mini",
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
        await saveChat({ id, messages, activeStreamId: null });
      },
    }),
    async consumeSseStream({ stream }) {
      await createResumableStreamContext({ waitUntil: after }).createNewResumableStream(streamId, () => stream);
      await saveChat({ id, activeStreamId: streamId });
    },
  });
}
```

```ts
// app/api/chat/[id]/stream/route.ts: GET resumes it
import { UI_MESSAGE_STREAM_HEADERS } from "ai";
import { after } from "next/server";
import { createResumableStreamContext } from "@upstash/agentkit-resumable-stream";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { activeStreamId } = await readChat((await params).id);
  if (!activeStreamId) return new Response(null, { status: 204 });
  const stream = await createResumableStreamContext({ waitUntil: after }).resumeExistingStream(activeStreamId);
  if (!stream) return new Response(null, { status: 204 }); // finished or expired
  return new Response(stream, { headers: UI_MESSAGE_STREAM_HEADERS });
}
```

```ts
// app/api/chat/[id]/stop/route.ts: POST stops it, from any instance
import { requestStop } from "@upstash/agentkit-resumable-stream";

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { activeStreamId } = await readChat((await params).id);
  if (activeStreamId) await requestStop(activeStreamId);
  return Response.json({ success: true });
}
```

The stopped `streamText` ends its stream, so `onEnd` still runs (with `isAborted: true`), saves the
partial answer and clears `activeStreamId`, and resumed readers see the stream finish.

## API

- `createResumableStreamContext({ waitUntil, redis?, keyPrefix?, ... })`: `resumable-stream/generic`'s
  context with the publisher and subscriber below (pass `publisher` / `subscriber` to replace them).
- `createUpstashPublisher(redis?, { maxMessageBytes? })` and `createUpstashSubscriber(redis?)`: the
  generic `Publisher` and `Subscriber`, for calling `resumable-stream/generic` yourself. Use them
  together: messages travel as `{"d":"<text>"}`, because Upstash delivers subscriptions as
  Server-Sent Events, which `@upstash/redis` splits on newlines and JSON-parses.
- `requestStop(streamId, redis?)` and `createStopSignal(streamId, { redis?, pollIntervalMs? })`, which
  returns `{ signal, dispose }`.

## Limits and cost

- **Large replays are split.** On resume, resumable-stream publishes everything buffered as one
  message, which Upstash rejects past the plan's request size
  ([vercel/resumable-stream#55](https://github.com/vercel/resumable-stream/issues/55)). Messages over
  `maxMessageBytes` (256 KiB) go out as ordered pieces on the same channel.
- **Publishes are batched.** The producer awaits each publish before reading the next chunk
  ([vercel/resumable-stream#52](https://github.com/vercel/resumable-stream/issues/52)). Publishes are
  queued per channel, resolve at once and go out in order, one pipeline request at a time; the DONE
  message waits for its channel to flush. A failed send is logged and rejects that channel's later
  publishes.
- **Subscriptions** hold one HTTP request open per channel: the producer's for the whole generation,
  and each resumed reader's. A dropped connection is not reopened. Stream ids cannot contain a comma.
- **Commands:** starting a stream is a SUBSCRIBE and two SETs (plus an INCR with
  `resumableStream`); chunks are only published while someone has resumed, one PUBLISH each (a
  pipeline saves round trips, not commands). A resume is a GET, a SUBSCRIBE and a PUBLISH, and a
  resumed reader GETs the sentinel every 10 s. `createStopSignal` is one EXISTS per
  `pollIntervalMs`: one per second by default, about 31 for a 30-second answer. `requestStop` is one
  SET.

## License

MIT
