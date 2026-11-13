# @upstash/agentkit-tanstack-ai

Production backends for [TanStack AI](https://tanstack.com/ai), all on one
[Upstash Redis](https://upstash.com/). TanStack AI defines the contracts for chat persistence,
resumable streaming, distributed locks and memory, and ships in-memory implementations that only
work inside one process. This package implements them on Redis, so they hold across serverless
instances, reloads and devices.

| TanStack AI seam                                           | This package                                                       | What you get                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `withPersistence()` / `withGenerationPersistence()` stores | `upstashPersistence()`                                             | Transcripts, runs, human-in-the-loop interrupts, metadata, generation jobs, artifacts and (with Upstash Blob) their bytes |
| `StreamDurability`                                         | `upstashStream()`                                                  | Reload mid-answer or open the thread on another device and pick up where the stream is                                    |
| `withLocks()` `LockStore`                                  | `upstashLocks()`                                                   | Distributed locks for TanStack AI middleware, e.g. so concurrent requests never create duplicate sandboxes                |
| `memoryMiddleware()` adapter                               | `upstashMemory()`                                                  | Long-term memory ranked in Redis Search (BM25, typo-tolerant), no per-turn full scan                                      |
| `createSandboxSnapshots()` / `withSandbox()` stores        | `upstashSandboxCheckpointStore()`, `upstashSandboxInstanceStore()` | Portable sandbox snapshots with history and forks, and any server can resume a thread's sandbox                           |
| `createMCPServer({ taskStore })`, MCP Events `{ store }`, `createMcpAppCallHandler({ store })` | `upstashMcpTaskStore()`, `upstashMcpEventStore()`, `upstashMcpSessionStore()` | Long-running MCP tasks, webhook subscriptions and MCP Apps sessions that survive restarts and work across instances |
| chat middleware                                            | `toolCache()`, `rateLimit()`                                       | Skip repeated deterministic tool calls; throttle users before the model runs                                              |
| tools                                                      | `createSearchTools()`                                              | `search` / `aggregate` / `count` over your own documents for RAG                                                          |

`upstashPersistence()`, `upstashMemory()` and the sandbox stores are checked against TanStack AI's
own conformance suites (`runPersistenceConformance`, `runMemoryAdapterContract`,
`runSandboxCheckpointStoreConformance`, `runSandboxCheckpointForkConformance`,
`runSandboxInstanceStoreConformance`, `runDurableRunFieldsConformance`).

## Install

```bash
npm install @upstash/agentkit-tanstack-ai @tanstack/ai
# plus, for the features you use:
npm install @tanstack/ai-persistence @tanstack/ai-memory @tanstack/ai-sandbox @tanstack/ai-mcp
```

Persistence, memory, sandbox and MCP stores have their own entry points
(`@upstash/agentkit-tanstack-ai/persistence`, `/memory`, `/sandbox`, `/mcp`, plus `/byok`), so the root
entry never needs those optional packages.

Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`; every factory defaults to
`Redis.fromEnv()` and accepts `redis` to pass a client explicitly.

## Chat persistence

```ts
import { chat } from "@tanstack/ai";
import { withPersistence } from "@tanstack/ai-persistence";
import { upstashPersistence } from "@upstash/agentkit-tanstack-ai/persistence";

const persistence = upstashPersistence({
  messagesTtlSeconds: 60 * 60 * 24 * 30, // optional: expire idle transcripts
});

chat({ adapter, messages, threadId, middleware: [withPersistence(persistence)] });
```

Stores `messages`, `activities` (frontend-only AG-UI activity rows), `runs`, `interrupts` and `metadata` (the full `ChatPersistence` shape). Runs are
indexed by thread, parent run and detach time, so reconnect (`findActiveRun`), subagent cards
(`listByParentRun`) and the sandbox reaper (`listReclaimable`) are index reads. Every mutation is a
single command or one Lua script, so concurrent instances cannot interleave a write.

It also stores `generationRuns` and `artifacts`, for one-shot generation jobs (image, video, speech)
saved by `withGenerationPersistence()`. Pass an [Upstash Blob](https://upstash.com/docs/blob) bucket to
add a `blobs` store for the generated bytes:

```ts
import { Bucket } from "@upstash/blob";

const persistence = upstashPersistence({ bucket: Bucket.fromEnv() });
```

The bytes go to the bucket and each blob's record (size, content type, custom metadata) to Redis, so
`head` and `list` are Redis reads and byte ranges are served with an HTTP `Range` request.

### Session index

`upstashPersistence()` also returns `stores.sessions`, TanStack AI's `SessionIndexStore`: one entry per
`(tenantId, threadId)` that a "your chats" list reads (title, members, harness, usage, pinned/archived,
your own `metadata`). `list` is newest-first per tenant with `memberId`, `search`, `harness`,
`parentThreadId` and `metadata` filters and a cursor; `upsertIf` writes only at the revision you read
(`getVersioned`), so hosts on several machines do not overwrite each other. The index holds no
messages, and `delete` removes only the entry. Use it on its own with `upstashSessionIndex(redis, prefix)`.

```ts
const { sessions } = upstashPersistence().stores;
await sessions.upsert({
  tenantId,
  threadId,
  members: [{ userId, role: "owner" }],
  title,
  createdAt: now,
  updatedAt: now,
});
const { entries, cursor } = await sessions.list({ tenantId, memberId: userId, limit: 20 });
```

### Session log

`stores.log` is TanStack AI's `LogStore`: the append-only log a host keeps for a session tree (events,
transcript, inputs, tool steps), with the pieces that let several machines share it safely.

- `append` writes a batch (at most 10,000 records per call) at the next position and consumes pending input offers in the same atomic step; a
  second writer at the same position gets a `LogConflictError` and nothing is written.
- `acquireOwnership` / `renewOwnership` / `releaseOwnership` give one owner at a time a lease with an epoch;
  every fenced write (`append`, `putSnapshot`, `truncate`, `pinToWorkers`) carries the epoch, so a host that
  lost the log gets an `OwnershipLostError`. Lease expiry uses the Redis clock, so hosts need no clock sync.
- `offerInput` / `listOfferedInputs` are the input lane any machine can write to; `listLogsWithoutOwner` finds
  logs whose owner expired, that have pending offers, or whose wake time is due (with `markHostAlive` and
  `pinToWorkers` for worker affinity).
- `putSnapshot` / `truncate` keep a log short; `read` after a truncate point rejects with `LogTruncatedError`.
- `subscribe` calls the listener after each write through this store immediately, and polls for writes from
  other machines every `logPollIntervalMs` (default 250 ms, since the REST API keeps no blocking reads; polls never overlap).

## Resumable streams

```ts
import { chat, toServerSentEventsResponse } from "@tanstack/ai";
import { upstashStream } from "@upstash/agentkit-tanstack-ai";

export async function POST(request: Request) {
  const stream = chat({ adapter, messages, threadId });
  return toServerSentEventsResponse(stream, { durability: { adapter: upstashStream(request) } });
}
```

Each chunk is appended to a Redis Stream before it is delivered. A client that reconnects with
`Last-Event-ID` (or `?offset`) replays everything after it and keeps tailing the live run, on any
instance. Without a `Request`, use `upstashStream({ runId, offset })`.

| Option                 | Default |                                                                      |
| ---------------------- | ------- | -------------------------------------------------------------------- |
| `ttlSeconds`           | `86400` | How long a run stays resumable after its last chunk                  |
| `pollIntervalMs`       | `150`   | Tail poll interval (the REST API keeps no blocking reads)            |
| `firstChunkDeadlineMs` | `2000`  | How long a from-start join waits for a run that has not produced yet |

## Distributed locks

```ts
import { withLocks } from "@tanstack/ai/locks";
import { upstashLocks } from "@upstash/agentkit-tanstack-ai";

chat({ adapter, messages, middleware: [withLocks(upstashLocks()), withSandbox(sandbox)] });
```

`withLocks` doesn't lock anything by itself: it hands the lock store to later middleware, which
take a lock around the one step they must not run twice. `withSandbox` does this so two concurrent
requests for a thread don't both create a sandbox, and your own middleware can do the same via
`getLocks(ctx)`. It does not serialize whole chat turns. TanStack's built-in `InMemoryLockStore` only
coordinates inside one process; `upstashLocks()` works across instances.

Each lock is a lease (`leaseMs`, default 30 s) renewed while the section runs; the section's `signal`
aborts if the lease is lost. Built on `RedisLock`, exported from this package too, which also exposes a
fencing token (`EventLog`, the Redis Streams log under `upstashStream`, is exported as well).

## Long-term memory

```ts
import { memoryMiddleware } from "@tanstack/ai-memory";
import { upstashMemory } from "@upstash/agentkit-tanstack-ai/memory";

chat({
  adapter,
  messages,
  middleware: [
    memoryMiddleware({
      adapter: upstashMemory(),
      // Derive these server-side from the session, never from the request body.
      scope: (ctx) => ({ threadId: ctx.threadId, userId: session.userId }),
    }),
  ],
});
```

- Recall runs before the model: the top matches for the user's message are injected as a system
  prompt block, each labelled with its source (`you saved this` / `the user said this`).
- The model gets a `save_memory` tool for durable facts (`saveTool: false` to turn it off).
- Each save waits for the index (`waitForIndexing`, default on), so a memory is recallable on the very
  next turn.
- Each turn's user message is captured (`captureUserMessages: false` for model-curated only).
- Memory is per user across threads by default (`scopeBy: "thread"` for per-conversation);
  `tenantId` and `namespace` always partition.

## Stored credentials (BYOK)

```ts
import { storedProviderKeys } from "@tanstack/ai/byok/server";
import { upstashCredentials } from "@upstash/agentkit-tanstack-ai/byok";

const credentials = upstashCredentials({ encryptionKey: process.env.CREDENTIALS_KEY });
await credentials.set({
  scope: { tenantId, userId },
  id: "openai",
  credential: { type: "api_key", value },
});
const keys = storedProviderKeys(credentials, { tenantId, userId }); // the user's key, else the tenant's
```

A `CredentialStore` for provider API keys and OAuth tokens users or organizations saved. One Redis hash
per owner (`tenantId` + `userId`), so `list` returns ids and types only, never a secret. `getVersioned` +
`setIf` are compare-and-set on a revision that never comes back after a `delete`, so concurrent
instances refreshing one OAuth token do not clobber each other. Needs `@tanstack/ai` >= 1.0.0.

**Encryption at rest.** Set `encryptionKey` (32 bytes: a `Uint8Array`, or a base64 / base64url / hex string,
e.g. `openssl rand -base64 32`) to encrypt secrets with AES-256-GCM. Without it they are stored as plain
JSON. Things to know:

- The ciphertext is bound to the key `prefix`, the owner, the id, and the clear-text type and expiry shown by
  `list`. **Changing `prefix`, or copying rows to another prefix, makes every encrypted row undecryptable**;
  editing the type or expiry in Redis makes that row fail to decrypt.
- Credentials saved before you added a key are still read as plaintext. Anyone who can _write_ to your Redis
  could therefore swap an encrypted credential for a plaintext one. After re-saving your credentials with the
  key, set `requireEncryption: true` to refuse plaintext rows.
- The revision is not part of the ciphertext, so someone with write access to your Redis can replay an older
  ciphertext of the same credential. Encryption protects against reading the data, not against a writer.
- Expired `secret_answer` credentials are not removed by the store; delete them after reading, as the
  harness does.

## Sandbox snapshots and instances

```ts
import { createSandboxSnapshots, withSandbox } from "@tanstack/ai-sandbox";
import { withPersistence } from "@tanstack/ai-persistence";
import { Bucket } from "@upstash/blob";
import { upstashLocks } from "@upstash/agentkit-tanstack-ai";
import { upstashPersistence } from "@upstash/agentkit-tanstack-ai/persistence";
import {
  upstashSandboxCheckpointStore,
  upstashSandboxInstanceStore,
} from "@upstash/agentkit-tanstack-ai/sandbox";

const persistence = upstashPersistence({ bucket: Bucket.fromEnv() }); // file bytes go to Upstash Blob
const instances = upstashSandboxInstanceStore();
const snapshots = createSandboxSnapshots({
  persistence,
  checkpoints: upstashSandboxCheckpointStore(), // same Redis + prefix as `persistence`
  instances,
  locks: upstashLocks(),
});

chat({
  adapter,
  messages,
  threadId,
  middleware: [
    withPersistence(snapshots.persistence),
    withSandbox(sandbox, { instances, snapshots }),
  ],
});

// Branch a conversation, files included, from any earlier checkpoint:
await snapshots.fork({ threadId, checkpointId, destinationThreadId: "thread-2" });
```

Portable snapshots let a later run rebuild a sandbox's files after the provider sandbox is gone.
Together with `upstashPersistence({ bucket })` and `upstashLocks()`, every store they need is on Upstash.
Pair them with TanStack's own Upstash Box provider, `@tanstack/ai-sandbox-upstash-box`, for the sandbox
itself.

- **`upstashSandboxCheckpointStore()`**: the `SandboxCheckpointStore`. Each checkpoint is one immutable
  document; each thread has a head pointer and an index. Appends are compare-and-set on the head, and every
  write first checks the writer lease (owner token, fence and expiry), so a writer that lost its lease
  changes nothing. Blob keys are reference-counted for cleanup (`listBlobReferences`). It supports
  `forkFromCheckpoint`: in one script, it copies a checkpoint into an empty thread and writes that thread's
  transcript. That's why it must use the same `redis` and `prefix` as `upstashPersistence()`. Pass the same
  `messagesTtlSeconds` too, if you set one.
- **`upstashSandboxInstanceStore()`**: the `SandboxInstanceStore` that maps a sandbox key to the
  provider's sandbox id and latest snapshot, so any server can resume the sandbox. Optional `ttlSeconds`.

Needs `@tanstack/ai-sandbox` >= 1.0.0.

## MCP task and event stores

```ts
import { createMCPClient } from "@tanstack/ai-mcp";
import { createMCPServer } from "@tanstack/ai-mcp/server";
import { upstashMcpEventStore, upstashMcpTaskStore } from "@upstash/agentkit-tanstack-ai/mcp";

// Server: long-running tools as MCP tasks, readable from any instance.
const server = createMCPServer({
  name: "tools",
  version: "1.0.0",
  tools,
  taskStore: upstashMcpTaskStore(),
});

// Client: MCP Events webhook subscriptions (direct mode), shared by every instance.
const mcp = await createMCPClient({
  transport: { type: "http", url: "https://mcp.example.com/mcp" },
  experimental_events: { store: upstashMcpEventStore() },
});
```

- **`upstashMcpTaskStore()`**: the `TaskStore` for `createMCPServer`. Task records survive restarts, and
  `tasks/get` / `tasks/result` work on any instance. The optional `ttlSeconds` expires finished records.
  Cancelling a task still stops its work only on the instance that is running it, because TanStack keeps
  the abort controller in memory.
- **`upstashMcpEventStore()`**: the `MCPEventStore` for MCP Events. Subscriptions, cursors and refresh
  deadlines are shared, so a webhook can land on any server. `update` is a compare-and-set, so concurrent
  cursor updates never lose a field. The subscription's webhook `secret` is stored as is.

Needs `@tanstack/ai-mcp` >= 1.0.0.

### MCP Apps sessions

```ts
import { createMcpAppCallHandler } from "@tanstack/ai-mcp/apps";
import { upstashMcpSessionStore } from "@upstash/agentkit-tanstack-ai/mcp";

const store = upstashMcpSessionStore({
  encryptionKey: process.env.MCP_SESSION_KEY, // encrypts each stored entry at rest
  // The parts of a descriptor that cannot live in Redis come from your code, per server:
  resolve: ({ threadId, serverId }) => ({
    needsApproval: (tool) => tool.annotations?.readOnlyHint !== true,
    authProvider: oauthProviderFor(threadId, serverId),
  }),
});

await store.set(threadId, servers); // in the chat route
const handleCall = createMcpAppCallHandler({ clients, store }); // widget calls, on any instance
```

`upstashMcpSessionStore()` is the `McpSessionStore` for MCP Apps. It records which MCP servers a
thread's widgets may call, so `createMcpAppCallHandler` can reconnect on any instance.

A server descriptor carries a policy for widget calls (`toolFilter`, `needsApproval`, `toolName`) and
often a transport `fetch` or OAuth `authProvider`. None of those survive JSON, so `set` splits each
descriptor:

- **The JSON part goes to Redis:** the transport, `prefix`, `requestOptions`, `clientOptions`, and an array `toolFilter`.
  One hash per thread, one field per server, encrypted whole when you pass `encryptionKey`.
- **Everything else is dropped and recorded by name.** `resolve` supplies it again on `get`, from your
  code. It receives `{ threadId, serverId, descriptor, missing }`.
- **It fails closed.** If `resolve` doesn't return a recorded field (say `needsApproval`), `get` returns
  `null`. The handler then uses its own registry entry for that server, or refuses the call. A widget
  never reaches a server whose approval gate was lost on the way through Redis.

Servers you also pass to `createMcpAppCallHandler({ clients })` get `toolFilter` / `needsApproval` /
`toolName` / `requestOptions` from that registry, so `resolve` matters most for servers that exist only
per thread. The TTL slides like `inMemoryMcpSessionStore` (`ttlSeconds`, default 1800).

Are you building an MCP _server_ with the official `@modelcontextprotocol/server` SDK instead of TanStack?
[`@upstash/mcp-toolkit`](https://github.com/upstash/agentkit/tree/main/packages/mcp-toolkit) gives you
durable tasks and events there, with QStash for background execution and webhook delivery.

## Tool caching and rate limiting

```ts
import { rateLimit, Ratelimit, toolCache } from "@upstash/agentkit-tanstack-ai";

chat({
  adapter,
  messages,
  tools: [getWeather, sendEmail],
  middleware: [
    rateLimit({ limiter: Ratelimit.slidingWindow(10, "60 s"), identifier: userId }),
    toolCache({ tools: ["get_weather"], userId, ttlSeconds: 600 }), // allowlist deterministic tools only
  ],
});
```

`rateLimit` fails the run with `RateLimitExceededError` before the model is called. To answer with
an HTTP 429 instead, call `createRateLimit({ limiter }).limit(userId)` in the route before `chat()`.

## Search tools (RAG)

```ts
import { s } from "@upstash/redis";
import { createSearchTools } from "@upstash/agentkit-tanstack-ai";

const tools = createSearchTools({
  indexName: "products",
  schema: s.object({ name: s.string(), price: s.number(), category: s.string().noTokenize() }),
});
chat({ adapter, messages, tools });
```

## Telemetry

Reports the package name and version as a header on your redis client's requests. Opt out with
`enableTelemetry: false` on any factory, on the redis client, or with `UPSTASH_DISABLE_TELEMETRY`.

## License

MIT
