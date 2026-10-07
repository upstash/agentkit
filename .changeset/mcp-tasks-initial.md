---
"@upstash/mcp-tasks": minor
---

Add `@upstash/mcp-tasks`: durable long-running tools for MCP servers on the official TypeScript SDK.

A task tool answers immediately with a task id; the model polls the shared `task_status` tool for
progress and the result, and can stop the task with `task_cancel`. They are ordinary MCP tools, so
they work in every client today, through `createMcpHandler` or any transport.

The task record lives in a `TaskStore` and the work runs behind a `TaskDispatcher`.
`@upstash/mcp-tasks/upstash` provides `RedisTaskStore` (Upstash Redis), `QStashDispatcher` (one
durable delivery per task, retried with backoff) and `WorkflowDispatcher` (one invocation per step,
for work that outlives a function). The dispatcher owns its delivery endpoint:
`export const POST = tasks.createExecuteHandler()`.

`principal` scopes tasks to their caller, and `idempotencyKey` turns an agent's retried start into a
read of the existing task.
