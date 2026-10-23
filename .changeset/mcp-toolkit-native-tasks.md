---
"@upstash/mcp-toolkit": major
---

Class-based API for both entry points. `@upstash/mcp-toolkit/tasks` exports `McpTasks` and
`@upstash/mcp-toolkit/events` exports `McpEvents`. Each is built once at module scope; tools and
events are registered on it there (`tasks.registerTask(name, config, handler)`,
`events.registerEvent(name, config)`), so an instance that only serves the execute or delivery
endpoint still knows every handler; and `attach(server)` adds them to each request's `McpServer`.
`createExecuteHandler()` and `createDeliveryHandler()` are unchanged. The options types are now
`McpTasksOptions` and `McpEventsOptions`.

```ts
// 0.1.0
const tasks = createTaskLayer({ store, dispatcher, principal });
tasks.define("generate_report", config, handler);
tasks.register(server);

const events = createEventLayer({ store, delivery, principal });
const commentCreated = events.define("comment.created", config);
events.register(server);

// now
const tasks = new McpTasks({ store, dispatcher, principal });
tasks.registerTask("generate_report", config, handler);
tasks.attach(server);

const events = new McpEvents({ store, delivery, principal });
const commentCreated = events.registerEvent("comment.created", config);
events.attach(server);
```

`createTaskLayer`, `createEventLayer`, `define`, `register` and the `TaskLayer`, `TaskLayerOptions`,
`TaskBackends`, `EventLayer` and `EventLayerOptions` types are removed.

Native MCP Tasks by default. `McpTasks` speaks the MCP Tasks extension
(`io.modelcontextprotocol/tasks`, protocol revision 2026-07-28): a tool call whose client declares
the extension (Claude Code CLI v2.1.304 and later) is answered with a native task
(`resultType: "task"`), and the client polls `tasks/get` and stops it with `tasks/cancel`, so the
model spends no turns polling. The server advertises the extension on `server/discover`. A client
that does not declare the extension still gets the task id in an ordinary tool result and polls
`task_status` / `task_cancel`, which stay listed for that fallback. `tasks.attach(server)` sets
everything up through the SDK's own extension points; no route changes are needed.

A completed task's `tasks/get` carries the tool result as-is. A failed task carries a JSON-RPC
`error`: for a handler that returned `isError`, its message is the result's text; for a transport
failure, the stored code and message (`error.data` stays in Redis). Unknown, expired, malformed or
another user's task ids answer `-32602`. `tasks/update` (`input_required`), `tasks/list` and
`tasks/result` are not served.

In-memory backends, and no backends needed to start. `@upstash/mcp-toolkit/tasks` now exports
`MemoryTaskStore` and `InProcessDispatcher`, and `store` / `dispatcher` are optional on
`McpTasks`, defaulting to that pair: `new McpTasks({ principal: () => "local" })` is a working
setup with no Redis, no QStash and no execute endpoint, only the MCP endpoint. The task runs in the
same process right after the tool call answers, with the same progress, cancellation, TTL and
failure semantics as the Upstash backends (a handler that throws fails the task; there are no
retries). In-memory tasks do not survive a restart and do not work across serverless invocations or
several instances: use `RedisTaskStore` with `QStashDispatcher` or `WorkflowDispatcher` there. In
production (`NODE_ENV=production`) the defaults log a one-time warning saying so; passing the
backends explicitly silences it. A `dispatcher` without a `store` is refused. Dispatchers may
implement the new optional `TaskDispatcher.connect(endpoints)`, which `McpTasks` calls when it is
constructed. A new task's first status message is now `"Queued"`.

Clients that declare the extension no longer receive the tool-based handle. To keep the 0.1.0
behaviour exactly (no `tasks/*` methods, no extension in the capabilities), pass `mode: "tools"`:

```ts
new McpTasks({ store, dispatcher, principal, mode: "tools" });
```
