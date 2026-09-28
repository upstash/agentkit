# TanStack AI on Upstash — demo

A chat app built on [TanStack AI](https://tanstack.com/ai) with every piece of its state in Upstash
Redis, via [`@upstash/agentkit-tanstack-ai`](../../packages/tanstack-ai):

- **Persistence**: transcripts, runs and approvals (`upstashPersistence`), so a reload rebuilds the
  thread.
- **Resumable streams**: every chunk goes to a Redis Stream first (`upstashStream`), so a reload —
  or the same URL on another device — continues the answer, on any server instance.
- **Detached runs**: closing the tab doesn't stop the model; the run finishes and is persisted.
  Next.js `after()` keeps the invocation alive for it on serverless hosts (up to `maxDuration`).
  `RedisLock` makes sure a duplicate request never starts a second run: its lease is renewed for the
  whole run, and a producer that ever loses it stops.
- **Memory**: facts saved in one thread are recalled in the next (`upstashMemory`).

It is TanStack AI's own persistent-chat pattern (from their `ts-react-chat` example) with the
in-memory and SQLite pieces swapped for Upstash, which is what makes it work across instances.

## Run it

```bash
cp .env.example .env   # then fill in:
# UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, and OPENAI_API_KEY
pnpm dev
```

No OpenAI key? `AGENTKIT_MOCK_MODEL=1 pnpm dev` runs a scripted model instead.

Try it: send a message, reload mid-answer, and watch it continue. Send `remember: I like green tea`,
then open a new thread and ask what it knows about you.

## End-to-end tests

```bash
pnpm build && pnpm e2e
```

Starts **two** production servers of this app against the same Upstash Redis, with the scripted
model, and checks what only shared backends can do:

| Scenario | What it proves |
| --- | --- |
| A client drops mid-answer on A, resumes on B | The stream is resumable across instances, with nothing missed or repeated |
| A reload on B while A is still generating | `reconstructChat` sees the in-flight run, then the finished transcript |
| `remember:` in one thread on A, ask in a new thread on B | Memory is shared across threads and instances, and isolated per user |
| The same run POSTed to both instances at once | Exactly one model run (`RedisLock`), one answer, one transcript entry |
| A run re-POSTed after its producer lease would have expired | The lease is renewed for the whole run, so it is still produced once |
| A malformed request | A 400, not a 500 |

Keys are written under a per-run prefix and deleted afterwards. Needs `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN` (the suite skips without them).
