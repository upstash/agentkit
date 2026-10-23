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

Breaking: clients that declare the extension no longer receive the tool-based handle. To keep the
0.x behaviour exactly (no `tasks/*` methods, no extension in the capabilities), pass
`mode: "tools"`:

```ts
createTaskLayer({ store, dispatcher, principal, mode: "tools" });
```
