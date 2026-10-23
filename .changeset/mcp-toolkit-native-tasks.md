---
"@upstash/mcp-toolkit": major
---

Native MCP Tasks by default. `createTaskLayer` now speaks the MCP Tasks extension
(`io.modelcontextprotocol/tasks`, protocol revision 2026-07-28): a tool call whose client declares
the extension (Claude Code CLI v2.1.304 and later) is answered with a native task
(`resultType: "task"`), and the client polls `tasks/get` and stops it with `tasks/cancel`, so the
model spends no turns polling. The server advertises the extension on `server/discover`. A client
that does not declare the extension still gets the task id in an ordinary tool result and polls
`task_status` / `task_cancel`, which stay listed for that fallback. `tasks.register(server)` sets
everything up through the SDK's own extension points; no route changes are needed.

A completed task's `tasks/get` carries the tool result as-is. A failed task carries a JSON-RPC
`error`: for a handler that returned `isError`, its message is the result's text; for a transport
failure, the stored code and message (`error.data` stays in Redis). Unknown, expired, malformed or
another user's task ids answer `-32602`. `tasks/update` (`input_required`), `tasks/list` and
`tasks/result` are not served.

In-memory backends, and no backends needed to start. `@upstash/mcp-toolkit/tasks` now exports
`MemoryTaskStore` and `InProcessDispatcher`, and `store` / `dispatcher` are optional on
`createTaskLayer`, defaulting to that pair: `createTaskLayer({ principal: () => "local" })` is a
working setup with no Redis, no QStash and no execute endpoint, only the MCP endpoint. The task runs
in the same process right after the tool call answers, with the same progress, cancellation, TTL and
failure semantics as the Upstash backends (a handler that throws fails the task; there are no
retries). In-memory tasks do not survive a restart and do not work across serverless invocations or
several instances: use `RedisTaskStore` with `QStashDispatcher` or `WorkflowDispatcher` there. In
production (`NODE_ENV=production`) the defaults log a one-time warning saying so; passing the
backends explicitly silences it. A `dispatcher` without a `store` is refused. Dispatchers may
implement the new optional `TaskDispatcher.connect(endpoints)`, which the layer calls when it is
created. A new task's first status message is now `"Queued"`.

Breaking: clients that declare the extension no longer receive the tool-based handle. To keep the
0.x behaviour exactly (no `tasks/*` methods, no extension in the capabilities), pass
`mode: "tools"`:

```ts
createTaskLayer({ store, dispatcher, principal, mode: "tools" });
```
