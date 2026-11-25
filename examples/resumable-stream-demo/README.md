# Resumable streams on Upstash Redis: demo

A minimal Next.js chat that follows the AI SDK's
[Chatbot Resume Streams](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams) guide, with
[`@upstash/agentkit-resumable-stream`](../../packages/resumable-stream) as the
[`resumable-stream`](https://github.com/vercel/resumable-stream) backend:

- **Resume**: `useChat({ resume: true })` reconnects to an answer that is still being generated, so a
  reload, or the same URL in another tab, picks it up where it is.
- **Stop from anywhere**: the Stop button calls a route that runs `requestStop`; the producer passes
  `createStopSignal(streamId).signal` to `streamText`, so it stops whichever server instance runs it.
  `useChat`'s own `stop()` is not used: with resumable streams it only drops the current connection.

| File | What it does |
| --- | --- |
| `app/api/chat/route.ts` | POST: `streamText`, with a copy of the stream sent to Redis (`consumeSseStream`) through `resumable-stream/generic` and the Upstash publisher and subscriber |
| `app/api/chat/[id]/stream/route.ts` | GET: resumes the chat's active stream |
| `app/api/chat/[id]/stop/route.ts` | POST: `requestStop` for the chat's active stream |
| `app/chat/[id]/chat.tsx` | The `useChat` client |
| `lib/chat-store.ts` | One Redis hash per chat: `messages` and `activeStreamId` |
| `lib/model.ts` | OpenAI, or a scripted model without a key |

## Run it

```bash
cp .env.example .env   # then fill in UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN and OPENAI_API_KEY
pnpm install           # from the repo root
pnpm --filter resumable-stream-demo dev
```

Create a Redis database in the [Upstash console](https://console.upstash.com) for the first two
variables. Without `OPENAI_API_KEY` (or with `AGENTKIT_MOCK_MODEL=1`) a scripted model answers
instead, one word every 100 ms (`MOCK_WORD_DELAY_MS`), which leaves time to try everything below.
`OPENAI_MODEL` picks the OpenAI model (default `gpt-5.4-mini`).

## Try it

Open <http://localhost:3000>; it redirects to a new chat.

1. **Reload mid-answer.** Send a message and reload the page while the answer is streaming. The
   answer comes back and continues to the end.
2. **Follow along in another tab.** Copy the chat URL into a second tab while it is still
   answering: both tabs show the same answer as it streams.
3. **Stop from another tab or instance.** Press Stop in either tab. The generation ends in both, and
   the partial answer is saved (reload to see it). To see it across instances, run a second server
   (`pnpm build`, then `pnpm start -p 3001`) and open the chat URL on port 3001: Stop there ends a
   generation running on port 3000.

Chats are stored under `resumable-stream-demo:chat:<id>` and expire after a week.
