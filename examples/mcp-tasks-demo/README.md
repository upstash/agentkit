# MCP Tasks demo

A Next.js app showing `@upstash/mcp-tasks` end to end: an MCP tool that answers with a task handle
instead of blocking, a task record in Upstash Redis, and the work running through QStash so it
survives the process that accepted the call.

The page is the MCP client. It speaks raw stateless JSON-RPC to `/api/mcp` — no initialize
handshake, no session id — and shows every frame it sends and receives in a wire log next to the
tasks, so you can watch the protocol rather than just the result.

## What's here

| File | What it does |
| --- | --- |
| `app/lib/tasks.ts` | The whole server wiring: `RedisTaskStore`, `QStashDispatcher`, and the `generate_report` task tool |
| `app/api/mcp/route.ts` | The MCP endpoint, over `WebStandardStreamableHTTPServerTransport` |
| `app/api/execute/route.ts` | Where QStash delivers a task — verifies the signature, then runs it |
| `app/page.tsx` | The client: call the tool, poll, cancel, and the wire log |
| `scripts/smoke.mjs` | Drives the same flow from the terminal and asserts on it |

## Run it

You need an [Upstash Redis database](https://upstash.com/start-redis). QStash you can run locally,
fully offline.

```bash
cp .env.example .env.local     # fill in UPSTASH_REDIS_REST_URL / _TOKEN

pnpm qstash                    # terminal 1 — prints the QStash URL, token and signing keys
                               #              paste those four into .env.local
pnpm dev                       # terminal 2
```

Then open http://localhost:3000, type a topic, and hit **Run tool**.

`APP_URL` is the one setting worth reading twice: it is where QStash delivers the task, so it has to
be reachable *from QStash*. The local dev server can reach `127.0.0.1`; the hosted service cannot,
so a deployed app needs its real URL (or a tunnel) there.

To check everything from the terminal instead:

```bash
pnpm smoke     # happy path, cancel mid-flight, a client without the capability, unknown task id
```

## The three things worth watching

**A tool call returns immediately.** `tools/call` comes back in milliseconds with
`resultType: "task"` and a `working` status. The four-step report takes about ten seconds; none of
it happens inside that request.

**Cancel is cooperative, in three layers.** Hit **cancel** mid-run and the store flips the status
to `cancelled`, the dispatcher cancels the pending QStash message, and the handler stops at its
next step boundary. The last layer is the one you cannot skip: running code only stops where it
checks. A completion arriving after the cancel is refused — terminal states are final.

**The work is durable, not just the record.** Start a task and kill the dev server mid-run:

```bash
pnpm dev
# start a task in the browser, then, a few seconds in:
kill -9 $(lsof -ti tcp:3000)
pnpm dev
```

Keep polling (the page resumes on its own) and the task still reaches `completed`. Redis kept the
record; QStash's redelivery is what finished the work. Replace the dispatcher with a
fire-and-forget promise and the same test leaves a permanently `working` task instead.

One caveat this demo learned the hard way: the retry budget has to outlast your restart. QStash
retries on its configured schedule and dead-letters the message when they run out, so with a flat
one-second delay every attempt is spent within a few seconds — long before a dev server is back up,
leaving a task that reads `working` forever. The dispatcher defaults to exponential backoff
(1s, 2s, 4s, 8s, 16s) for that reason. If a task ends up dead-lettered anyway, it is in the QStash
DLQ, not lost.

## Notes

- The tool is an ordinary MCP tool. Nothing in `tools/list` marks it as a task; the server decides
  per call, from the capabilities the request carries.
- A client that has not declared `io.modelcontextprotocol/tasks` gets a structured tool error
  telling it what to declare, instead of a task it cannot poll.
- The route uses `WebStandardStreamableHTTPServerTransport` rather than `createMcpHandler` on
  purpose — see the note in `app/api/mcp/route.ts` and the package README.
