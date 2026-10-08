# @upstash/mcp-toolkit

Durable building blocks for MCP servers built on the official TypeScript SDK
(`@modelcontextprotocol/server`), running on Upstash Redis and QStash.

- **`/tasks`: long-running tools.** The tool answers right away with a task id, and the model
  polls `task_status` until the result is ready. The work runs on QStash, so the process that took
  the call can die and the client's tool-call timeout no longer limits it. Works in every MCP client.
- **`/events`: MCP Events.** A host subscribes to an event on your server and gets a signed
  webhook when it happens, so the agent wakes up instead of polling. Works in ChatGPT today.
- **`/upstash`: the Upstash backends** for both: `RedisTaskStore`, `QStashDispatcher`,
  `WorkflowDispatcher`, `RedisSubscriptionStore`, `QStashDelivery`.

```bash
npm install @upstash/mcp-toolkit @modelcontextprotocol/server zod
```

Environment variables:

```bash
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
QSTASH_TOKEN=...
QSTASH_CURRENT_SIGNING_KEY=...   # required: delivery routes refuse to run without them
QSTASH_NEXT_SIGNING_KEY=...
MCP_EVENTS_SECRET_KEY=...        # events only. Generate with: openssl rand -base64 32
APP_URL=https://your-app.com     # used in the snippets below. QStash has to be able to reach it
```

## Who is calling

Both layers need `principal`: a function that returns the id of the user making the call. Tasks
belong to the user who started them, and subscriptions to the user who subscribed. Read it from the
token your MCP route has verified, and throw when there is none:

```ts
// lib/auth.ts
import type { Caller } from "@upstash/mcp-toolkit/tasks";

export function principal({ auth }: Caller): string {
  const userId = auth?.extra?.userId;
  if (typeof userId !== "string") throw new Error("Not authenticated");
  return userId;
}
```

<details>
<summary><b>More on <code>principal</code></b></summary>

- **A throw refuses the call.** There is no anonymous mode: if `principal` throws, rejects, or
  returns anything but a non-empty string, the call is refused as not authenticated.
- **Use the user id, not `auth.clientId`.** The client id identifies the OAuth app, and every
  ChatGPT user shares the same one.
- `auth` is only what your route passed to `handler.fetch(request, { authInfo })` (see below). The
  SDK never fills it from headers.
- `principal` also receives `request`, for cookie or session apps. It is unverified, so check the
  session yourself, and never trust a header like `x-user-id`.
- A server with no users of its own passes `principal: () => "local"`.

</details>

## Long-running tools

```ts
// lib/tasks.ts
import { McpServer } from "@modelcontextprotocol/server";
import { createTaskLayer } from "@upstash/mcp-toolkit/tasks";
import { QStashDispatcher, RedisTaskStore } from "@upstash/mcp-toolkit/upstash";
import * as z from "zod";
import { principal } from "./auth";

export const tasks = createTaskLayer({
  store: new RedisTaskStore(),
  dispatcher: new QStashDispatcher({ url: `${process.env.APP_URL}/api/execute` }),
  principal,
});

// Define at module scope, so the /api/execute instance knows the handler too.
tasks.define(
  "generate_report",
  { description: "Generates a report on a topic.", inputSchema: z.object({ topic: z.string() }) },
  async ({ topic }, task) => {
    await task.update("Reading sources"); // the model sees this when it polls
    return { content: [{ type: "text", text: await writeReport(topic) }] };
  },
);

export function createServer() {
  const server = new McpServer({ name: "reports", version: "1.0.0" });
  tasks.register(server); // adds generate_report, task_status and task_cancel
  return server;
}
```

```ts
// app/api/mcp/route.ts
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { createServer } from "../../lib/tasks";

const handler = createMcpHandler(() => createServer());

export async function POST(request: Request) {
  // Clerk, WorkOS, Auth0, your own. `principal` reads the user id from `authInfo.extra`.
  const authInfo: AuthInfo | undefined = await verifyToken(request);
  if (!authInfo) return new Response("Unauthorized", { status: 401 });
  return handler.fetch(request, { authInfo });
}
```

```ts
// app/api/execute/route.ts: QStash delivers the work here
import { tasks } from "../../lib/tasks";

export const POST = tasks.createExecuteHandler();
```

`tools/list` now has `generate_report` (starts the task and returns its id), `task_status` (shows
progress, then the handler's result) and `task_cancel`. To stop a cancelled task, check
`await task.isCancelled()` between steps. Cancelling is cooperative, so running code only stops
where it checks.

<details>
<summary><b>What the model sees</b></summary>

```jsonc
// generate_report: a handle, right away
{ "content": [{ "type": "text", "text": "Started task 0e30…. Call task_status with taskId \"0e30…\" in about 2s to check on it." }],
  "structuredContent": { "taskId": "0e30…", "status": "working", "ttlMs": 300000, "pollIntervalMs": 2000 } }

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
until the task expires (5 minutes by default; set `defaults: { ttlMs }` on the layer).

</details>

<details>
<summary><b>Work that takes longer than one function invocation: <code>WorkflowDispatcher</code></b></summary>

With QStash, the whole handler runs in one serverless invocation. If it goes past your platform's
time limit, it is killed, and the retry starts the handler from the beginning. Upstash Workflow
runs each step in its own invocation and replays finished steps from a journal, so a task has no
overall time limit. Only the dispatcher changes. The routes stay the same.

```ts
import { RedisTaskStore, WorkflowDispatcher } from "@upstash/mcp-toolkit/upstash";

export const tasks = createTaskLayer({
  store: new RedisTaskStore(),
  dispatcher: new WorkflowDispatcher({ url: `${process.env.APP_URL}/api/execute` }),
  principal,
  defaults: { ttlMs: 60 * 60 * 1000 }, // keep the record longer than the work takes
});

tasks.define(
  "migrate_workspace",
  { description: "Copies a workspace to new storage.", inputSchema: z.object({ workspaceId: z.string() }) },
  async ({ workspaceId }, task) => {
    const batches = await task.run("plan", () => listBatches(workspaceId));
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
is deleted and `isCancelled()` returns true, so set `ttlMs` longer than the work takes.

|                                    | `QStashDispatcher`         | `WorkflowDispatcher`            |
| ---------------------------------- | -------------------------- | ------------------------------- |
| Survives the process dying         | yes (QStash redelivers)    | yes (replayed from the journal) |
| Can run longer than one invocation | no                         | yes, one invocation per step    |
| On a retry                         | the whole task starts over | only the failed step runs again |
| Cancel stops a running task        | at its next `isCancelled`  | the run itself is cancelled     |

</details>

<details>
<summary><b>Retries and failures</b></summary>

- The execute route answers **200** when the task ran (or had already finished), **500** when your
  handler threw, so QStash tries again, and **489** with `Upstash-NonRetryable-Error` when the
  signature or body is bad.
- Every delivery's QStash signature is checked against the URL you gave the dispatcher, not
  `request.url`, so it works behind a proxy and a signature issued for another endpoint is refused.
  Without signing keys the route throws instead of running anything unverified.
- When your handler throws, the task is not marked failed. Only the dispatcher marks it `failed`,
  and only after QStash has stopped retrying. The failed message stays in the QStash DLQ.
- By default QStash tries 5 times with backoff `min(pow(3, retried) * 1000, 300000)`, about two
  minutes in total, so a task survives a server restart. The free tier and the local dev server
  allow at most 5 retries.

</details>

<details>
<summary><b>Why plain tools and not the MCP Tasks extension?</b></summary>

The 2026-07-28 spec defines a Tasks extension (`io.modelcontextprotocol/tasks`), where the
_client_ polls and the model spends no turns on it. But a server may only return a task to a client
that declared the extension, and as of October 2026 Claude Code, Codex, Cursor and OpenCode don't.
Plain tools cost the model a few polling calls but work everywhere today. The store and dispatcher
don't depend on the tools, so an adapter for the extension can serve the same records later.

</details>

## Events

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

Call `events.register(server)` in `createServer()`, next to `tasks.register(server)`, and add the
route QStash delivers to:

```ts
// app/api/events/route.ts
import { events } from "../../lib/events";

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
come from, and the same values are used to route it and to authorize it. A subscription matches
when each argument it gave equals the payload's value. Emitting
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

Pass `{ eventId }` as the second argument to `emit` to deduplicate: emitting the same id twice
delivers once.

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

**Tasks.** The server sets the owner from `principal`, and no tool argument can set it.
`task_status` and `task_cancel` only accept UUID task ids, and compare the stored owner with the
caller. For anyone else, the task looks exactly like an unknown id, so they can't even tell it
exists. Task ids are random UUIDs. No tool lists tasks, and the execute route only accepts signed
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
`subscriber`, `createdAt`, `expiresAt`), expiring with it. **`mcp-events:idx:<event>`**: a sorted
set of the event's subscription ids, scored by expiry.

**Not in Redis.** A task message in QStash carries only `{ taskId }`. An event message carries the
full payload, which stays in QStash (and in its DLQ, if every retry fails) until it is delivered.
The toolkit never stores the caller's token, the request, the plaintext webhook secret or
`MCP_EVENTS_SECRET_KEY`.

</details>

<details>
<summary><b>All options</b></summary>

**`createTaskLayer`**: `store`, `dispatcher` and `principal` are required. Optional:
`defaults.ttlMs` (5 min) and `defaults.pollIntervalMs` (2s).

**`tasks.define(name, config, handler)`**: `description` and `inputSchema` are required. Optional:
`title`, `completedMessage`.

**`createEventLayer`**: `store`, `delivery` and `principal` are required, and so is `secretKey`
unless `MCP_EVENTS_SECRET_KEY` is set. Optional: `allowInsecureCallbacks`.

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
interfaces (types exported from the same entry points):

```ts
interface TaskStore {
  create(task: Task): Promise<void>; // with its TTL
  get(taskId: string): Promise<Task | null>;
  update(taskId: string, patch: TaskPatch): Promise<void>; // ignored once the task is final
  settle(taskId: string, patch: TaskPatch & { status: TerminalTaskStatus }): Promise<Task | null>; // first final status wins
}

interface TaskDispatcher<TContext = unknown> {
  dispatch(task: Task): Promise<void>; // idempotent per task id
  cancel(taskId: string): Promise<void>;
  createExecuteHandler(endpoints: TaskEndpoints<TContext>): (request: Request) => Promise<Response>;
}

interface SubscriptionStore {
  put(subscription: Subscription): Promise<void>;
  get(id: string): Promise<Subscription | null>;
  delete(subscription: { id: string; event: string }): Promise<void>;
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

- `input_required`: a handler asking the user something partway through a task.
- Listing tasks.
- An adapter for the MCP Tasks extension. It would use the same store, and is waiting for clients
  to support the extension.
- Event replay (`cursor`) and the draft's poll and stream delivery modes.

</details>
