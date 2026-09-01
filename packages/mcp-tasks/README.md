# @upstash/mcp-tasks

A durable [MCP Tasks](https://github.com/modelcontextprotocol/ext-tasks) runtime for the official
TypeScript SDK, with Upstash Redis and QStash as the backends.

The 2026-07-28 MCP spec made the protocol stateless: no `initialize` handshake, no `Mcp-Session-Id`,
every request carrying its own protocol version, client identity and capabilities in `_meta`. Long
running tools got the Tasks extension — a tool call answers with a task handle and the client polls
for the result. The official TypeScript SDK v2 ships the wire schemas for it but **no tasks
runtime**; the v1 experimental task APIs were removed with no migration path.

This package is that runtime. It is one factory over two interfaces, so the storage and the
execution transport are yours to choose:

| Layer | Interface | What it has to guarantee | What ships here |
| --- | --- | --- | --- |
| Task record | `TaskStore` | Durable create before the response, TTL cleanup | Upstash Redis hash + `PEXPIRE` |
| Execution | `TaskDispatcher` | At-least-once delivery that survives a dead process, cancellable while pending | QStash publish to your execute endpoint |
| Polling | — | `tasks/get` reads the store | built in |

## Why two interfaces and not one

A durable task ID does not make the underlying work durable. Write the record to shared storage and
then run the work in a fire-and-forget promise, and a deploy mid-task leaves you with a perfectly
durable record of a task stuck in `working` until its TTL expires. The record and the work are
separate problems, so they get separate seams.

## Install

```bash
npm install @upstash/mcp-tasks @modelcontextprotocol/server @upstash/redis @upstash/qstash
```

`@upstash/redis` and `@upstash/qstash` are only needed for the Upstash backends, which live behind
the `@upstash/mcp-tasks/upstash` entry point. Bring your own store and the root import pulls
neither.

## Usage

```ts
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { createTaskLayer, TASKS_PROTOCOL_VERSION } from "@upstash/mcp-tasks";
import { QStashDispatcher, RedisTaskStore } from "@upstash/mcp-tasks/upstash";
import * as z from "zod";

const tasks = createTaskLayer({
  store: new RedisTaskStore(), //           optional: { redis, prefix, enableTelemetry }
  dispatcher: new QStashDispatcher({
    url: `${process.env.APP_URL}/api/execute`, // where QStash delivers the task
    // retries / retryDelay default to a budget that outlives a restart — see below
  }),
  defaults: { ttlMs: 300_000, pollIntervalMs: 2_000 }, // optional
});

export function createServer() {
  const server = new McpServer(
    { name: "reports", version: "1.0.0" },
    // Required: the transport otherwise rejects 2026-07-28 requests as an unsupported version.
    { supportedProtocolVersions: [TASKS_PROTOCOL_VERSION] },
  );

  tasks.registerTask(
    server,
    "generate_report",
    {
      description: "Generates a report in four durable steps",
      inputSchema: z.object({ topic: z.string() }),
      ttlMs: 300_000, //        optional: retention, null for unlimited
      pollIntervalMs: 2_000, // optional: what to suggest to the client
    },
    async ({ topic }, task) => {
      for (let step = 1; step <= 4; step++) {
        if (await task.isCancelled()) return {};
        await task.update(`Step ${step}/4: processing ${topic}`);
        await doWork(topic, step);
      }
      return { content: [{ type: "text", text: `Report complete: ${topic}` }] };
    },
  );

  return server;
}
```

Then two endpoints — the MCP transport, and the one QStash delivers to:

```ts
// POST /api/mcp
const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
  enableJsonResponse: true,
});
await createServer().connect(transport);
return transport.handleRequest(request);
```

```ts
// app/api/execute/route.ts
export const POST = tasks.createExecuteHandler();
```

That second one is deliberately not yours to write. Verifying the QStash signature, reading the
task id, counting which attempt this is and picking the status code that decides whether QStash
tries again are all facts about the transport, and the dispatcher already knows them — so it hands
you the endpoint instead of a checklist. Skipping the signature check would let anyone who can
reach the route run tasks; here you cannot skip it.

If you would rather wire it yourself, the pieces are still exported — `executeTask`,
`isFinalQStashAttempt(headers, dispatcher.retries)` and `@upstash/qstash`'s `Receiver`.

## What the client sees

```jsonc
// tools/call  →  a handle, immediately
{ "resultType": "task", "taskId": "0e30…", "status": "working",
  "statusMessage": "Queued for durable execution", "ttlMs": 300000, "pollIntervalMs": 2000 }

// tasks/get   →  progress, then the result inline
{ "resultType": "complete", "taskId": "0e30…", "status": "working", "statusMessage": "Step 3/4: …" }
{ "resultType": "complete", "taskId": "0e30…", "status": "completed", "statusMessage": "Completed",
  "result": { "content": [{ "type": "text", "text": "Report complete: coffee trends" }] } }
```

Five states — `working`, `input_required`, `completed`, `failed`, `cancelled` — of which the last
three are terminal and never change again.

## Design notes

Five things here are deliberate, and most of them differ from the obvious implementation.

**The record is written before the handle goes out.** The spec requires it: the client may
`tasks/get` the id against another instance the moment it has it. So `registerTask` creates, then
dispatches, then responds — never the other way around.

**Terminal transitions go through `settle`, not `update`.** Two writers race for the end of a task
by design — a client's `tasks/cancel` and the executor finishing at the same moment. `settle` moves
a task to a terminal state *only if it is not terminal already*, atomically (a Lua script on Redis),
and returns `null` when it lost. A check-then-write would let a late `completed` overwrite a
`cancelled`; this cannot. The store also keeps one field per task property rather than one JSON
blob, so a progress update and a cancel never clobber each other's fields.

**A failed attempt is not automatically a failed task.** Settling `failed` on the first error makes
the task terminal, and every subsequent redelivery then short-circuits on the redelivery guard — so
QStash's retries would be silently useless. `executeTask(id, { isFinalAttempt })` is what
distinguishes them: before the last attempt the task stays `working` and the error is rethrown so
your endpoint can answer non-2xx; on the last one it settles `failed`. `isFinalQStashAttempt` reads
that from the `Upstash-Retried` header.

**Redelivery is expected, not exceptional.** At-least-once is the strongest thing a queue promises,
so `executeTask` returns early on an already-terminal task.

**The retry budget has to outlast a restart.** This is the one default most likely to bite you. A
task is only as durable as the number of redeliveries left when the process died — run out, and the
record survives in Redis while nothing ever finishes the work, leaving `working` until the TTL
expires. QStash caps `retries` per plan (the local dev server and the free tier reject anything
above **5** with `quota maxRetries exceeded`), so the budget is bought with backoff instead: the
default delay is `min(pow(3, retried) * 1000, 300000)` — 1s, 3s, 9s, 27s, 81s, about two minutes
across five attempts. Raise `retries` if your plan allows; for comparison, Vercel's QStash-backed
Workflow world defaults to 47.

## Two gotchas in the official SDK

Both verified against `@modelcontextprotocol/server@2.0.0`, and both are why this package exists in
the shape it does.

**`createMcpHandler` cannot serve `tasks/get` / `tasks/cancel`.** It pins each request to the
2026-07-28 era from the client's envelope claim, and on that era the SDK's dispatch gate answers
those two methods with `-32601` *before* looking up your handler — they are claimed spec vocabulary
in its 2025 registry and were dropped from the 2026 one, so they are neither dispatchable nor
free-form. Either serve with `WebStandardStreamableHTTPServerTransport` (or the Node one) and
`transport.handleRequest`, which stays on the 2025 era where they dispatch normally — the per-request
`_meta` envelope is still lifted, so nothing else changes — or keep `createMcpHandler` and move the
operations to your own namespace:

```ts
createTaskLayer({ store, dispatcher, methods: { get: "upstash/tasks.get", cancel: "upstash/tasks.cancel" } });
```

**A tool callback cannot return a JSON-RPC error.** `McpServer` catches everything a tool callback
throws — `ProtocolError` and `MissingRequiredClientCapabilityError` included — and flattens it into
`{ content, isError: true }`, dropping the code. So a client that has not declared the tasks
capability gets a structured tool error instead, with the code and the capability it is missing in
`structuredContent`:

```jsonc
{ "isError": true,
  "content": [{ "type": "text", "text": "\"generate_report\" answers with a task handle, which requires …" }],
  "structuredContent": { "code": -32021,
    "requiredCapabilities": { "extensions": { "io.modelcontextprotocol/tasks": {} } } } }
```

Pass `onMissingCapability: "run-inline"` to run the handler and answer normally instead — spec-legal,
since the server chooses per call, but it brings back the blocking request tasks exist to avoid.

## Bringing your own backend

Implement `TaskStore` (four methods) and `TaskDispatcher` (two), and the core does not change. A
Postgres store is the same methods over one table with a cleanup job standing in for `PEXPIRE`; a
BullMQ dispatcher is an `add` returning the job id and a `remove` for cancel.
`MemoryTaskStore` + `InlineTaskDispatcher` ship for tests and local runs — neither is durable, which
is exactly the failure this package is about.

## API

| Export | What it is |
| --- | --- |
| `createTaskLayer(options)` | The runtime: `{ registerTask, executeTask, createExecuteHandler, getTask, store, dispatcher }` |
| `TaskStore`, `TaskDispatcher`, `TaskContext`, `TaskRunner` | The two seams, what a handler is handed, and what a delivery endpoint calls |
| `Task`, `WireTask`, `TaskStatus`, `TaskError` | The record, and the subset that goes on the wire |
| `isTerminal`, `TERMINAL_STATUSES`, `UnknownTaskError` | Status helpers and the store's error type |
| `TASKS_EXTENSION`, `TASKS_PROTOCOL_VERSION`, `TASK_METHODS` | The extension id, `"2026-07-28"`, the method names |
| `MemoryTaskStore`, `InlineTaskDispatcher` | Non-durable backends for tests |
| `@upstash/mcp-tasks/upstash` | `RedisTaskStore`, `QStashDispatcher`, `isFinalQStashAttempt`, `DEFAULT_RETRIES`, `DEFAULT_RETRY_DELAY` |

## Not implemented

`tasks/update` (the client answering an `input_required` task) and `tasks/list`. The latter is
absent from the spec on purpose — without sessions a server cannot scope a list to one caller
without leaking that other people's tasks exist. `tasks/update` would follow the same shape as the
other two: write the client's answer into the record, and let the handler read it at a step
boundary, exactly as it reads the cancelled status today.

The `ext-tasks` repo labels itself experimental and its schema is a draft, so these wire shapes may
change before Tasks lands in core.
