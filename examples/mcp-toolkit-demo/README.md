# MCP toolkit demo

A Next.js app showing `@upstash/mcp-toolkit` end to end: an MCP tool that answers with a task handle
instead of blocking, a task record in Upstash Redis, and the work running through QStash (or
Upstash Workflow) so it survives the process that accepted the call.

The page is the MCP client, and it does exactly what a model would: call `generate_report`, then
poll `task_status` and maybe call `task_cancel` — three ordinary tools, from a client that declares
no capabilities at all. It speaks raw stateless JSON-RPC and shows every frame in a wire log.

## What's here

| File | What it does |
| --- | --- |
| `app/lib/qstash-server.ts` | Server one: Redis store, QStash dispatcher, and the `generate_report` task tool |
| `app/lib/workflow-server.ts` | Server two: the same tool on Upstash Workflow, one invocation per step |
| `app/api/mcp/route.ts`, `app/api/mcp-workflow/route.ts` | The MCP endpoints — the SDK's own `createMcpHandler`, unchanged |
| `app/api/execute/route.ts`, `app/api/execute-workflow/route.ts` | Where the work is delivered. One line each: the dispatcher owns the endpoint |
| `app/lib/deploy-watch.ts` | **Deploy Watch**, the events server: the `deploy.finished` event and a `list_recent_deploys` tool |
| `app/api/deploy-watch/route.ts` | Deploy Watch's MCP endpoint |
| `app/api/deploy-watch/events/route.ts` | Where QStash delivers each event. One line: the delivery owns the endpoint |
| `app/api/deploy-watch/deploys/route.ts` | Report a deploy (stands in for your CI), which fires `deploy.finished` |
| `app/api/receiver/route.ts` | A stand-in for the host's webhook receiver, so events can be seen without a public URL |
| `app/lib/auth.ts` | Stand-in authentication: `Bearer demo-<name>` is user `demo-<name>`, no header is `demo-user` |
| `app/page.tsx` | The client: call the tool, poll, cancel, and the wire log |
| `scripts/smoke.mjs` | The e2e checks, as raw JSON-RPC against a running app |
| `scripts/e2e.mjs` | Starts the QStash dev server and the built app, and runs the checks against both task servers |
| `app/lib/e2e.ts` | Test hooks for `scripts/e2e.mjs` only (`MCP_TOOLKIT_E2E=1`) |

## Run it

You need an [Upstash Redis database](https://upstash.com/start-redis). QStash you can run locally,
fully offline.

```bash
cp .env.example .env.local     # fill in UPSTASH_REDIS_REST_URL / _TOKEN, and
                               # MCP_EVENTS_SECRET_KEY=$(openssl rand -base64 32)

pnpm qstash                    # terminal 1 — prints the QStash URL, token and signing keys
                               #              paste those four into .env.local
pnpm dev                       # terminal 2
```

Then open http://localhost:3000, type a topic, and hit **Run tool**.

`APP_URL` is the one setting worth reading twice: it is where QStash delivers the task, so it has to
be reachable *from QStash*. The local dev server can reach `127.0.0.1`; the hosted service cannot,
so a deployed app needs its real URL (or a tunnel) there.

## Tests

No model and no QStash account: the checks speak raw JSON-RPC, as a model and a host would.

```bash
pnpm build && pnpm e2e    # starts the QStash dev server and the app, runs everything, stops them
```

Against both task servers it checks a task running to completion, cancel, another user's task
reading as unknown (`Bearer demo-alice` vs `Bearer demo-bob`), a bad token getting 401, a task that
throws ending `failed`, and unsigned or forged deliveries being refused. Against Deploy Watch: a
filtered subscription getting exactly one validly signed webhook, another user's unsubscribe
changing nothing, `authorize` refusing `demo-intern` production deploys at subscribe time and at
delivery, and a host's 410 deleting the subscription. CI runs it on every PR.

Against an app you already have running (`pnpm dev` + `pnpm qstash`), `pnpm smoke` runs the same
checks, and `MCP_PATH=/api/mcp-workflow pnpm smoke` the Workflow ones. The failure check is
skipped there unless the app was started with `MCP_TOOLKIT_E2E=1`.

## Two separate tests

The demo serves two unrelated MCP servers, so tasks and events can be tried on their own:

| | Report Desk (tasks) | Deploy Watch (events) |
| --- | --- | --- |
| Endpoint | `/api/mcp` | `/api/deploy-watch` |
| What it has | `generate_report` + `task_status` / `task_cancel` | the `deploy.finished` event + `list_recent_deploys` |
| Works in | every MCP client | hosts that support MCP Events (ChatGPT) |
| Try it | ask the agent for a report; it polls until done | subscribe in a ChatGPT Work chat, then `POST /api/deploy-watch/deploys` |

For ChatGPT, `APP_URL` stays `http://127.0.0.1:3000` (QStash runs next to the app), and the app
needs a public URL for ChatGPT to reach the MCP endpoint, e.g. a tunnel or an Upstash Box preview.

## Two transports

The demo runs two servers side by side, picked in the UI. They expose the same tools; only
durability differs:

- **QStash** (`/api/mcp`): one delivery, one invocation. Survives a crash, but the whole handler
  has to finish inside the route's `maxDuration`.
- **Workflow** (`/api/mcp-workflow`): each `task.run(...)` becomes its own request, replayed from a
  journal, so the task can run far longer than any one invocation.

## The three things worth watching

**A tool call returns immediately.** `generate_report` comes back in milliseconds with a
`taskId` and a `working` status in `structuredContent`, plus a sentence telling the model to call
`task_status`. The four-step report takes about ten seconds; none of it happens inside that
request. Once it completes, `task_status` returns the report's own content.

**Cancel is cooperative, in three layers.** Hit **cancel** mid-run and the store flips the status
to `cancelled`, any redelivery finds the task settled and does nothing (on Workflow the run itself
is cancelled), and the handler stops at its next step boundary. The last layer is the one you cannot skip: running code only stops where it
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
retries on its configured schedule, and when the attempts run out its failure callback marks the
task `failed`. With a flat one-second delay every attempt is spent within a few seconds, long
before a dev server is back up. The dispatcher's defaults spread five attempts over about two
minutes (1s, 3s, 9s, 27s, 81s) for that reason; five is also the ceiling the local dev server and
the free tier allow, so raising `retries` needs a plan that permits it. A failed message stays in
the QStash DLQ.

## Notes

- All three tools are ordinary MCP tools, so this works in every client today — Claude Code,
  Codex, Cursor, OpenCode, ChatGPT — none of which declare the protocol's Tasks extension yet.
- The demo has no real login. `app/lib/auth.ts` stands in for one: the MCP routes turn
  `Authorization: Bearer demo-<name>` into the user `demo-<name>` and pass it to the SDK as
  `authInfo`, and `principal` reads it back, as a real server would with a verified token. With no
  header the caller is the shared `demo-user`, so the page and an unauthenticated ChatGPT
  connection keep working; a real server answers 401 instead.
