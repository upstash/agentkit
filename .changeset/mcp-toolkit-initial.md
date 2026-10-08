---
"@upstash/mcp-toolkit": minor
---

Add `@upstash/mcp-toolkit`: durable building blocks for MCP servers on the official TypeScript SDK.

`@upstash/mcp-toolkit/tasks` — long-running tools. A task tool answers immediately with a task id;
the model polls the shared `task_status` tool for progress and the result, and can stop the task
with `task_cancel`. They are ordinary MCP tools, so they work in every client today. The record
lives in a `TaskStore` and the work runs behind a `TaskDispatcher`, and the dispatcher owns its
delivery endpoint (`export const POST = tasks.createExecuteHandler()`) and always verifies QStash's
signature against the URL it published to. Tasks are declared once at module scope with
`tasks.define(...)` and attached to each request's server with `tasks.register(server)`. A required
`principal` scopes tasks to their caller (and subscriptions to theirs).

`@upstash/mcp-toolkit/events` — MCP Events with webhook delivery, as ChatGPT ships it. Typed
`events.define(...)` handles with `emit(payload)`: the payload's values route the event and are what
the required `authorize` is checked against, at subscribe and again before every delivery.
`events/list`, `events/subscribe` and `events/unsubscribe` are registered on your server, with a
signed verification challenge, deterministic subscription ids, expiry and refresh, SSRF checks on
callback URLs, and signing secrets encrypted at rest. `QStashDelivery` signs each attempt with
Standard Webhooks and lets QStash retry failures (`export const POST = events.createDeliveryHandler()`).

The package uses WebCrypto only, so it runs on Node and edge runtimes.

`@upstash/mcp-toolkit/upstash` holds the Upstash backends for both: `RedisTaskStore`,
`QStashDispatcher`, `WorkflowDispatcher`, `RedisSubscriptionStore` and `QStashDelivery`.
`@upstash/redis`, `@upstash/qstash` and `@upstash/workflow` are regular dependencies.
