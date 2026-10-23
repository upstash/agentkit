# @upstash/mcp-toolkit

Building blocks for MCP servers built on the official TypeScript SDK
(`@modelcontextprotocol/server`).

- **`/tasks`: long-running tools.** The tool answers right away and the work runs in the
  background, so the client's tool-call timeout no longer limits it. Runs in memory with nothing
  else to set up; add Upstash Redis and QStash (or Workflow) to make it durable.
- **`/events`: MCP Events.** A host subscribes to an event on your server and gets a signed
  webhook when it happens, so the agent wakes up instead of polling. Works in ChatGPT today.
- **`/upstash`: the Upstash backends** for both: `RedisTaskStore`, `QStashDispatcher`,
  `WorkflowDispatcher`, `RedisSubscriptionStore`, `QStashDelivery`.

```bash
npm install @upstash/mcp-toolkit @modelcontextprotocol/server zod
```

## Long-running tools

A slow tool becomes a task: the call returns at once and the work carries on in the background.
Clients that support the [MCP Tasks extension](https://modelcontextprotocol.io/extensions/tasks)
(the Claude Code CLI) get a native task, which they poll and show themselves. Every other client
gets a task id in an ordinary tool result, and the model checks on it with the `task_status` and
`task_cancel` tools.

### An MCP server with a slow tool

```ts
// mcp.ts
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { createTaskLayer } from "@upstash/mcp-toolkit/tasks";
import * as z from "zod";

// No store or dispatcher: tasks are kept in memory and run in this process.
const tasks = createTaskLayer({ principal: () => "local" });

// Define at module scope; the handler runs after the tool call has answered.
tasks.define(
  "generate_report",
  { description: "Writes a report on a topic.", inputSchema: z.object({ topic: z.string() }) },
  async ({ topic }, task) => {
    for (const step of ["Reading sources", "Drafting", "Polishing"]) {
      if (await task.isCancelled()) return {};
      await task.update(step); // progress, shown to whoever polls
      await new Promise((resolve) => setTimeout(resolve, 2000)); // the slow part
    }
    return { content: [{ type: "text", text: `A report on ${topic}.` }] };
  },
);

const mcp = createMcpHandler(() => {
  const server = new McpServer({ name: "reports", version: "1.0.0" });
  server.registerTool(
    "ping",
    { description: "An ordinary tool, for comparison.", inputSchema: z.object({}) },
    async () => ({ content: [{ type: "text", text: "pong" }] }),
  );
  tasks.register(server); // generate_report, task_status, task_cancel, tasks/get, tasks/cancel
  return server;
});

// Serve POST /mcp with it.
export const handler = (request: Request): Promise<Response> => mcp.fetch(request);
```

`handler` is a Web-standard `(request: Request) => Promise<Response>`, so it mounts in any
framework: `export const POST = handler` in a Next.js route, `app.post("/mcp", (c) =>
handler(c.req.raw))` in Hono, `Bun.serve({ fetch: handler })`, or Node through an adapter such as
`@hono/node-server`.

That is the whole setup: no database, no queue and no other endpoint. The catch is that the tasks
live in this process. See [Make it durable](#make-it-durable-redis--qstash-or-workflow) before you
deploy to serverless or run more than one instance.

### What the client sees

`tools/list` has `ping`, `generate_report`, `task_status` and `task_cancel`, and the server
advertises the Tasks extension on `server/discover`. A call to `generate_report` is answered
according to the client:

- **A client that declares the Tasks extension** on the call (Claude Code, see below) gets a
  native task (`resultType: "task"`). The client polls `tasks/get` itself, shows the progress, and
  hands the model the handler's result when it is done; the model spends no turns polling.
  `tasks/cancel` stops it.
- **Any other client** gets the task id in an ordinary tool result. The model polls `task_status`
  (progress, then the handler's result) and can stop the task with `task_cancel`.

Both read the same record. Cancelling is cooperative: running code only stops where it checks
`await task.isCancelled()`, so check it between steps.

### Make it durable: Redis + QStash (or Workflow)

In memory, a task is lost when the process restarts, and it only exists on the instance that took
the call. On serverless, or behind several instances, the next `tasks/get` may reach an instance
that never saw the task, and work left running after the response can be frozen or killed with the
function. Keep the records in Upstash Redis and deliver the work through QStash instead: the record
is shared by every instance, QStash retries a failed run, and each run gets a fresh invocation.

```bash
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
QSTASH_URL=...                   # your QStash region's URL, from the console
QSTASH_TOKEN=...
QSTASH_CURRENT_SIGNING_KEY=...   # required: the execute endpoint refuses to run without them
QSTASH_NEXT_SIGNING_KEY=...
APP_URL=https://your-app.com     # QStash has to be able to reach it
```

Pass a store and a dispatcher; the tool definitions and the MCP handler stay exactly as they were:

```ts
import { createTaskLayer } from "@upstash/mcp-toolkit/tasks";
import { QStashDispatcher, RedisTaskStore } from "@upstash/mcp-toolkit/upstash";

const tasks = createTaskLayer({
  store: new RedisTaskStore(),
  dispatcher: new QStashDispatcher({ url: `${process.env.APP_URL}/api/execute` }),
  principal: () => "local",
});

// tasks.define(...) and the MCP handler as above, then one more endpoint.
// QStash delivers each task here: serve POST /api/execute with it.
export const execute: (request: Request) => Promise<Response> = tasks.createExecuteHandler();
```

The execute endpoint is just another `(request: Request) => Promise<Response>`, mounted like the
MCP one, at the URL you gave the dispatcher. Every instance that serves it must import the module
that calls `tasks.define(...)`, so it knows the handlers.

For work that can outlast one function invocation, use `WorkflowDispatcher` (same `url`, same
endpoint): each step runs in its own invocation, so a task has no overall time limit (see "Work
that takes longer than one function invocation" below).

|                                    | in memory (default)          | `QStashDispatcher`         | `WorkflowDispatcher`            |
| ---------------------------------- | ---------------------------- | -------------------------- | ------------------------------- |
| Needs                              | nothing                      | Redis, QStash, an endpoint | Redis, QStash, an endpoint      |
| Serverless, several instances      | no                           | yes                        | yes                             |
| Survives the process dying         | no                           | yes (QStash redelivers)    | yes (replayed from the journal) |
| Can run longer than one invocation | n/a: as long as the process  | no                         | yes, one invocation per step    |
| When the handler throws            | `failed`, no retry           | the whole task starts over | only the failed step runs again |

In production (`NODE_ENV=production`), the in-memory defaults log a one-time warning. If a single
long-lived server is what you want, pass them explicitly to say so:
`createTaskLayer({ store: new MemoryTaskStore(), dispatcher: new InProcessDispatcher(), principal })`
(both from `@upstash/mcp-toolkit/tasks`). `await dispatcher.drain()` on shutdown lets running tasks
finish.

### Who is calling: `principal`

Both layers need `principal`: a function that returns the id of the user making the call. Tasks
belong to the user who started them, and subscriptions to the user who subscribed. `() => "local"`
is for a server with no users of its own. Otherwise, verify the token and hand the result to the
SDK, which passes it to `principal`:

```ts
// auth.ts
import type { AuthInfo } from "@modelcontextprotocol/server";
import type { Caller } from "@upstash/mcp-toolkit/tasks";

// 1. Your token check. Clerk, WorkOS, Auth0, your own.
export async function verifyToken(request: Request): Promise<AuthInfo | undefined> {
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token) return undefined;
  const { sub, client_id } = await verifyJwt(token);
  return { token, clientId: client_id, scopes: [], extra: { userId: sub } };
}

// 2. The toolkit calls this with the AuthInfo above. Return the user id, or throw.
export function principal({ auth }: Caller): string {
  const userId = auth?.extra?.userId;
  if (typeof userId !== "string") throw new Error("Not authenticated");
  return userId;
}
```

```ts
// mcp.ts: createTaskLayer({ principal, ... }), and the handler checks the token first
export async function handler(request: Request): Promise<Response> {
  const authInfo = await verifyToken(request);
  if (!authInfo) return new Response("Unauthorized", { status: 401 });
  return mcp.fetch(request, { authInfo });
}
```

With [`mcp-handler`](https://www.npmjs.com/package/mcp-handler), its `withMcpAuth` does the same
(there, `verifyToken` gets the bearer token as a second argument).

<details>
<summary><b>More on <code>principal</code></b></summary>

- **A throw refuses the call.** There is no anonymous mode: if `principal` throws, rejects, or
  returns anything but a non-empty string, the call is refused as not authenticated.
- **Use the user id, not `auth.clientId`.** The client id identifies the OAuth app, and every
  ChatGPT user shares the same one.
- `auth` is exactly the `authInfo` your handler passed to `fetch`. Nothing is read from headers on
  its own.
- `principal` also receives `request`, for cookie or session apps (`Caller` is `{ auth, request }`,
  from `@upstash/mcp-toolkit/tasks` or `/events`). `request` is unverified, so check the session
  yourself, and never trust a header like `x-user-id`.

</details>

**Check what the arguments point at.** The model fills in tool arguments, so a `workspaceId` in
them is whatever it was told. Give the task an `authorize`, which runs before the task is stored or
queued, and use `task.principal` (the user who started the task) inside the handler. Never take a
user id from the arguments:

```ts
tasks.define(
  "export_workspace",
  {
    description: "Exports a workspace to CSV.",
    inputSchema: z.object({ workspaceId: z.string() }),
    // May this user export this workspace? `false` refuses the call.
    authorize: ({ workspaceId }, { principal }) => canExport(principal, workspaceId),
  },
  async ({ workspaceId }, task) => {
    const csv = await exportWorkspace(workspaceId, { as: task.principal });
    return { content: [{ type: "text", text: csv }] };
  },
);
```

### Going further

<details>
<summary><b>Which clients get native tasks</b></summary>

A server may only answer with a task when the request declares the extension, in
`_meta["io.modelcontextprotocol/clientCapabilities"].extensions["io.modelcontextprotocol/tasks"]`
(protocol revision 2026-07-28). The layer checks that on every call, so one server serves both
kinds of client.

- **Claude Code** CLI from v2.1.304 (terminal, Agent SDK and GitHub Actions sessions) declares it on
  calls from the main conversation. It does not on calls from a subagent, in the VS Code extension
  or the desktop app, or on a 2025-era connection; those get the tool-based handle.
- **Other clients** (Codex, Cursor and OpenCode, as of October 2026) don't declare it and get the
  tool-based handle.

`task_status` and `task_cancel` stay listed in native mode. They are the fallback, and Claude Code
itself needs them for the calls it can't turn into tasks. Claude Code shows the model a native
task's id, so the model may call `task_status` on it too; both paths read the same record and give
the same answer. Hiding the tools per client would break the fallback, since one client sends both
kinds of call.

The server advertises the extension on `server/discover` (`capabilities.extensions`), and answers:

```jsonc
// tools/call generate_report, from a client that declared the extension
{ "resultType": "task", "taskId": "0e30…", "status": "working", "statusMessage": "Queued",
  "createdAt": "…", "lastUpdatedAt": "…", "ttlMs": 86400000, "pollIntervalMs": 2000 }

// tasks/get { taskId }: the same fields, plus `result` (the tool result) once completed,
// or `error` once failed
{ "resultType": "complete", "taskId": "0e30…", "status": "completed", "statusMessage": "Completed", …,
  "result": { "content": [{ "type": "text", "text": "Report on coffee" }] } }

// tasks/cancel { taskId }
{ "resultType": "complete" }
```

- A **failed** task carries the JSON-RPC `error` the extension requires. When the handler returned
  a tool error (`isError: true`), the message is that result's text, which is what the model would
  have read from a synchronous tool; when the transport gave up, it is the stored code and message.
  `error.data` stays in the store, as with `task_status`.
- An unknown, expired or malformed task id, another user's task, and an unidentified caller all get
  the same `-32602` error, so ids can't be probed.
- No other `tasks/*` method is served: `tasks/update` (`input_required`), `tasks/list` and
  `tasks/result` answer "Method not found", and there are no `notifications/tasks`. Claude Code
  uses none of them.
- Everything goes through the SDK's own extension points, so `tasks.register(server)` stays the
  only setup, with the SDK's `createMcpHandler` or `mcp-handler` alike. Call it before the server
  is connected, as both factories do.

</details>

<details>
<summary><b>Keep the old behaviour (tools only)</b></summary>

0.x answered every client with the tool-based handle. To keep exactly that (no `tasks/*`
methods, no extension in the server's capabilities), set `mode: "tools"`:

```ts
const tasks = createTaskLayer({ principal, mode: "tools" }); // default: "native"
```

</details>

<details>
<summary><b>What the model sees (tool-based handle)</b></summary>

```jsonc
// generate_report: a handle, right away
{ "content": [{ "type": "text", "text": "Started task 0e30…. Call task_status with taskId \"0e30…\" in about 2s to check on it." }],
  "structuredContent": { "taskId": "0e30…", "status": "working", "ttlMs": 86400000, "pollIntervalMs": 2000 } }

// task_status: progress…
{ "content": [{ "type": "text", "text": "Task 0e30… is working: Reading sources. Check again in about 2s." }],
  "structuredContent": { "taskId": "0e30…", "status": "working", "statusMessage": "Reading sources" } }

// …then the handler's own content, as if the tool had run synchronously
{ "content": [{ "type": "text", "text": "Task 0e30… is completed: Completed" },
              { "type": "text", "text": "Report on coffee" }],
  "structuredContent": { "taskId": "0e30…", "status": "completed", "result": { "content": [ … ] } } }
```

The states are `working`, `completed`, `failed` and `cancelled`; the last three are final. The
task object has the same shape as the one in the MCP Tasks extension.

If the model stops polling, nothing is lost: the work finishes anyway, and the result can be read
until the task expires (1 day by default; set `defaults: { ttlMs }` on the layer).

</details>

<details>
<summary><b>Work that takes longer than one function invocation: <code>WorkflowDispatcher</code></b></summary>

With QStash, the whole handler runs in one serverless invocation. If it goes past your platform's
time limit, it is killed, and the retry starts the handler from the beginning. Upstash Workflow
runs each step in its own invocation and replays finished steps from a journal, so a task has no
overall time limit. Only the dispatcher changes. The endpoints stay the same.

```ts
import { RedisTaskStore, WorkflowDispatcher } from "@upstash/mcp-toolkit/upstash";

const tasks = createTaskLayer({
  store: new RedisTaskStore(),
  dispatcher: new WorkflowDispatcher({ url: `${process.env.APP_URL}/api/execute` }),
  principal,
});

tasks.define(
  "migrate_workspace",
  {
    description: "Copies a workspace to new storage.",
    inputSchema: z.object({ workspaceId: z.string() }),
    authorize: ({ workspaceId }, { principal }) => isOwner(principal, workspaceId),
  },
  async ({ workspaceId }, task) => {
    const batches = await task.run("plan", () => listBatches(workspaceId, task.principal));
    for (const [i, batch] of batches.entries()) {
      if (await task.isCancelled()) return {};
      await task.update(`Copying batch ${i + 1}/${batches.length}`);
      await task.run(`copy-${i}`, () => copyBatch(batch));
    }
    return { content: [{ type: "text", text: "Done" }] };
  },
);
```

With Workflow, `task` also has `run`, `sleep` and `call`. The handler runs again from the top on
every step, and finished steps are replayed from the journal:

- Put the work inside `task.run`. That makes it run once and survive a crash.
- `task.update(...)` does not need wrapping.
- Keep `task.isCancelled()` outside steps. It has to run again each time, or a later cancel is
  never seen.
- Don't nest `task.run` calls.
- Each step must still fit within your function's time limit.

The task's TTL starts when the task is created and is never extended. When it runs out, the record
is deleted and `isCancelled()` returns true. The default is 1 day; set `ttlMs` higher for work that
can take longer.

With `WorkflowDispatcher`, cancelling a task also cancels its run; with QStash, a running task
stops at its next `isCancelled()`.

</details>

<details>
<summary><b>Retries and failures</b></summary>

- **In memory** (`InProcessDispatcher`) there are no retries: when your handler throws, the task is
  `failed` at once, with the message "The task handler threw an error". What it threw is logged
  and kept in the record's `error.data`, never shown to the model.
- The execute endpoint answers **200** when the task ran (or had already finished), **500** when your
  handler threw, so QStash tries again, and **489** with `Upstash-NonRetryable-Error` when the
  signature or body is bad.
- Every delivery's QStash signature is checked against the URL you gave the dispatcher, not
  `request.url`, so it works behind a proxy and a signature issued for another endpoint is refused.
  Without signing keys the route throws instead of running anything unverified.
- When your handler throws, the task is not marked failed. Only the dispatcher marks it `failed`,
  and only after QStash has stopped retrying. The failed message stays in the QStash DLQ.
- When your handler _returns_ a tool error (`isError: true`), the task is `failed` at once, with no
  retry, and `task_status` returns your content with `isError`, as the synchronous tool would.
- What a failure looks like to the model is `error.code` and `error.message`. The transport's
  details (`error.data`: the QStash DLQ id, the Workflow run id) stay in Redis for you. What your
  handler threw (Workflow's failure response) and a dispatch error are logged, never stored or
  returned.
- By default QStash tries 5 times with backoff `min(pow(3, retried) * 1000, 300000)`, about two
  minutes in total, so a task survives a server restart. The free tier and the local dev server
  allow at most 5 retries.

</details>

## Events

Events need Upstash Redis and QStash: the environment variables from
[Make it durable](#make-it-durable-redis--qstash-or-workflow), plus `MCP_EVENTS_SECRET_KEY`
(generate it with `openssl rand -base64 32`). `principal` is the one from
[Who is calling](#who-is-calling-principal).

```ts
// lib/events.ts
import { createEventLayer } from "@upstash/mcp-toolkit/events";
import { QStashDelivery, RedisSubscriptionStore } from "@upstash/mcp-toolkit/upstash";
import * as z from "zod";
import { principal } from "./auth";

export const events = createEventLayer({
  store: new RedisSubscriptionStore(),
  delivery: new QStashDelivery({ url: `${process.env.APP_URL}/api/events` }),
  principal,
});

export const commentCreated = events.define("comment.created", {
  description: "A new comment was added to a document.",
  input: z.object({ documentId: z.string().optional() }), // what a subscriber may filter on
  payload: z.object({ documentId: z.string(), text: z.string() }),
  // May this user see comments on this document?
  authorize: (args, { principal }) => canRead(principal, args.documentId),
});
```

Call `events.register(server)` in the `createMcpHandler` callback, next to `tasks.register(server)`, and add the
route QStash delivers to:

```ts
// app/api/events/route.ts
import { events } from "@/lib/events";

export const POST = events.createDeliveryHandler();
```

Then emit from anywhere in your server code:

```ts
await commentCreated.emit({ documentId: "doc_123", text: "Ship it?" });
```

Every subscription that matches the payload, and that `authorize` still allows for
`documentId: "doc_123"`, gets a signed webhook. QStash retries failed deliveries with backoff, and
the event id stays the same across retries so the host can drop duplicates.

<details>
<summary><b>Matching and <code>authorize</code></b></summary>

Every `input` field must also be a `payload` field: the payload is the one place an event's values
come from, and the same values are used to route it and to authorize it. The payload's values for
the input fields are parsed with the `input` schema, so its transforms apply on both sides and
`authorize` gets the types it declares. A subscription matches when each argument it gave equals
the payload's value. Emitting
`{ documentId: "doc_123", text }` reaches subscribers of `{ documentId: "doc_123" }` and of `{}`.

`authorize(args, caller)` runs twice:

- **On every subscribe and refresh**, with the subscription's arguments and
  `{ principal, phase: "subscribe", auth, request }`, before the callback is challenged or anything
  is stored. A refusal is an error to the host.
- **Before every delivery**, with the _event's_ values for the input fields and
  `{ principal, phase: "deliver" }`. So a subscriber who filtered on nothing is still checked
  against each event's `documentId`, and revoked access stops the events. A refusal drops that
  delivery; a throw (your database is down, say) makes QStash retry it.

`() => true` lets every authenticated subscriber hear every matching event.

Pass `{ eventId }` as the second argument to `emit` to give an event a stable id. It is sent as
`webhook-id`, so a host drops a second emit with the same id as a duplicate.

</details>

<details>
<summary><b>What the layer checks for you</b></summary>

- **The caller first.** `events/subscribe` and `events/unsubscribe` resolve `principal` before
  anything else, so an unidentified caller learns nothing about your events. A subscription's id is
  a hash of subscriber, callback URL, event and arguments, so a user can only refresh or remove
  their own.
- **The callback URL.** It must be `https` on a public host name. Refused: every IP literal,
  `localhost`, single-label, `.local` and `.internal` names, and credentials in the URL. Redirects
  are never followed. Before a subscription is stored, the server POSTs a signed challenge and
  requires the host to echo it back. Every failure returns the same `-32015` error, so a subscriber
  can't use it to probe your network (the details go to your logs). DNS is not resolved, so use
  egress filtering in production. `allowInsecureCallbacks: true` turns these checks off. Use it in
  local development only.
- **The signing secret.** It must be `whsec_` followed by 24 to 64 base64 bytes, and it is stored
  encrypted with AES-256-GCM under `MCP_EVENTS_SECRET_KEY`, which must be base64 of at least 32
  random bytes. A refresh with the same secret skips the challenge. If you rotate the key, stored
  subscriptions stop receiving events until the host refreshes them.
- **Lifetime.** A subscription lasts 7 days by default and 30 days at most.
- **How many.** A subscriber holds at most 8 live subscriptions across all events (set
  `maxSubscriptions`; `Infinity` turns it off). Past that, a new subscribe is refused before the
  callback is challenged, with reason `subscription_limit`; refreshing an existing one still works.
  Each subscription is a webhook per matching emit, so this bounds what one user can make your
  server send.
- **Host answers.** `410` deletes the subscription, `413` and redirects drop the event, and any
  other error is retried.
- **Not implemented:** the draft's poll and stream delivery modes (`events/subscribe` refuses
  them) and event replay (`cursor` is always `null`).

</details>

<details>
<summary><b>Which hosts subscribe today</b></summary>

As of October 2026, ChatGPT is the only widely used host that subscribes to MCP Events (webhook
mode, in Work chats; see [OpenAI's guide](https://developers.openai.com/plugins/build/mcp-events)).
Codex supports events only for OpenAI's own connectors. Claude Code, Cursor and OpenCode don't
subscribe yet. The spec draft is
[here](https://github.com/modelcontextprotocol/experimental-ext-triggers-events).

</details>

## Reference

<details>
<summary><b>Who can see what</b></summary>

**Tasks.** The server sets the owner from `principal`, and no tool argument can set it. Whether a
caller may start a task with given arguments is your `authorize`; the handler gets the owner as
`task.principal`.
`task_status`, `task_cancel`, `tasks/get` and `tasks/cancel` only accept UUID task ids, and
compare the stored owner with the caller. For anyone else, the task looks exactly like an unknown
id (a tool error for the tools, `-32602` for `tasks/*`), so they can't even tell it exists. Task ids are random UUIDs. No tool lists tasks, and the execute route only accepts signed
QStash deliveries and never returns a task.

**Events.** See "Matching and `authorize`" above. The token is never stored, so the
delivery-time check gets no `auth`.

**What this does not cover.** Whether your `authorize` is correct is up to you. Every recipient of
an emit gets the same payload, so don't put data in it that only some matching subscribers may see.
Anyone with write access to your Redis can change an owner or a callback URL.

</details>

<details>
<summary><b>What is stored in Redis</b></summary>

Treat the Redis credentials like any other production secret.

**`mcp:task:<taskId>`**: a hash with one JSON-encoded field per property: `taskId`, `name`,
`args`, `owner`, `status`, `statusMessage`, `result` / `error`, `createdAt`, `lastUpdatedAt`,
`ttlMs`, `pollIntervalMs`.

- `args` and `result` are **plain JSON**. Keep secrets out of tool arguments and results, or use a
  short `ttlMs`.
- The task is written with its TTL before the tool replies, because the model's next poll may
  reach another instance. The TTL counts from creation and is never extended.
- Status changes go through one guarded Lua script, and the first final status wins, so a
  completion can't overwrite a cancel. Each property is its own field, so a progress update and a
  cancel never overwrite each other.
- A Redis client built with `automaticDeserialization: false` is not supported.

**`mcp-events:sub:<id>`**: the subscription (`event`, `args`, `url`, `encryptedSecret`,
`subscriber`, `createdAt`, `expiresAt`), expiring with it. **`mcp-events:idx:<event>`** and
**`mcp-events:by:<subscriber>`**: sorted sets of the event's and the subscriber's subscription ids,
scored by expiry. The second one enforces the limit.

**Not in Redis.** A task message in QStash carries only `{ taskId }`. An event message carries the
full payload, which stays in QStash (and in its DLQ, if every retry fails) until it is delivered.
The toolkit never stores the caller's token, the request, the plaintext webhook secret or
`MCP_EVENTS_SECRET_KEY`.

</details>

<details>
<summary><b>All options</b></summary>

**`createTaskLayer`**: `principal` is required. Optional: `store` (a `MemoryTaskStore` by
default) and `dispatcher` (an `InProcessDispatcher` by default; a dispatcher needs a store with
it), `mode` (`"native"`, or `"tools"` for the tool-based handle only), `defaults.ttlMs` (1 day) and
`defaults.pollIntervalMs` (2s), in positive whole milliseconds.

**`tasks.define(name, config, handler)`**: `description` and `inputSchema` are required. Optional:
`title`, `completedMessage`, `authorize(args, { principal, auth, request })`.

**`createEventLayer`**: `store`, `delivery` and `principal` are required, and so is `secretKey`
unless `MCP_EVENTS_SECRET_KEY` is set. Optional: `maxSubscriptions` (8), `allowInsecureCallbacks`.

**`events.define(name, config)`**: `description`, `payload` and `authorize` are required.
Optional: `title`, `input`.

**`RedisTaskStore`** / **`RedisSubscriptionStore`**: `redis` (defaults to one from env), `prefix`
(`mcp:task:` / `mcp-events:`), `enableTelemetry`.

**`QStashDispatcher`**: `url` is required. Optional: `qstash`, `receiver`, `retries` (5),
`retryDelay`, `enableTelemetry`.

**`WorkflowDispatcher`**: `url` is required. Optional: `client`, `qstash`, `receiver`, `retries`,
`enableTelemetry`.

**`QStashDelivery`**: `url` is required. Optional: `qstash`, `receiver`, `enableTelemetry`.
Deliveries are retried 3 times with QStash's backoff.

`receiver` defaults to one built from the `QSTASH_*_SIGNING_KEY` variables. If neither is
available, the route throws on its first request instead of running a delivery unverified.

**Telemetry.** The Redis and QStash clients get `@upstash/mcp-toolkit@<version>` added to their
`Upstash-Telemetry-Sdk` header. Turn it off with `enableTelemetry: false` or
`UPSTASH_DISABLE_TELEMETRY`.

</details>

<details>
<summary><b>Custom backends</b></summary>

`/tasks` and `/events` don't import anything from Upstash. A backend implements one of these
interfaces (types exported from the same entry points). `MemoryTaskStore` and
`InProcessDispatcher` are small examples of the first two:

```ts
interface TaskStore {
  create(task: Task): Promise<void>; // with its TTL
  get(taskId: string): Promise<Task | null>;
  update(taskId: string, patch: TaskPatch): Promise<void>; // ignored once the task is final
  settle(taskId: string, patch: TaskPatch & { status: TerminalTaskStatus }): Promise<Task | null>; // first final status wins
}

interface TaskDispatcher<TContext = unknown> {
  dispatch(task: Task): Promise<void>; // called once per task
  cancel(taskId: string): Promise<void>;
  createExecuteHandler(endpoints: TaskEndpoints<TContext>): (request: Request) => Promise<Response>;
  connect?(endpoints: TaskEndpoints<TContext>): void; // called when the layer is created
}

interface SubscriptionStore {
  // false, storing nothing, when a new one would put its subscriber over `limit` (atomically)
  put(subscription: Subscription, options: { limit: number }): Promise<boolean>;
  get(id: string): Promise<Subscription | null>;
  count(subscriber: string): Promise<number>; // live subscriptions, across all events
  delete(subscription: { id: string; event: string; subscriber: string }): Promise<void>;
  find(event: string): Promise<Subscription[]>; // every live subscription to the event
}

interface EventDelivery {
  enqueue(jobs: DeliveryJob[]): Promise<void>;
  createDeliveryHandler(send: SendJob): (request: Request) => Promise<Response>;
}
```

`/events` also exports `verifyWebhook` (Standard Webhooks) for writing a receiver.

</details>

<details>
<summary><b>Not implemented yet</b></summary>

- `input_required`: a handler asking the user something partway through a task (`tasks/update`
  answers "Method not found").
- Listing tasks (`tasks/list`) and `notifications/tasks`.
- Event replay (`cursor`) and the draft's poll and stream delivery modes.

</details>
