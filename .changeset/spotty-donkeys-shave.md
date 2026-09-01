---
"@upstash/mcp-tasks": minor
---

Add `@upstash/mcp-tasks`: a durable MCP Tasks runtime for the official TypeScript SDK.

The 2026-07-28 spec made MCP stateless and moved long-running tools to the Tasks extension, but the
official v2 SDK ships the wire schemas with no runtime behind them. This package adds one:
`createTaskLayer({ store, dispatcher })` turns a tool into a task-returning tool and serves
`tasks/get` and `tasks/cancel`, over two swappable interfaces — a `TaskStore` for the record and a
`TaskDispatcher` for the execution. `@upstash/mcp-tasks/upstash` provides both on Upstash Redis
(one hash per task, `PEXPIRE` for TTL) and QStash (durable at-least-once delivery to your execute
endpoint), so work survives the process that accepted the tool call.
