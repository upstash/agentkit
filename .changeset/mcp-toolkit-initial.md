---
"@upstash/mcp-toolkit": minor
---

Add `@upstash/mcp-toolkit`: durable building blocks for MCP servers on the official TypeScript SDK.

`@upstash/mcp-toolkit/tasks` — long-running tools. A task tool answers immediately with a task id;
the model polls the shared `task_status` tool for progress and the result, and can stop the task
with `task_cancel`. They are ordinary MCP tools, so they work in every client today. The record
lives in a `TaskStore` and the work runs behind a `TaskDispatcher`; `/tasks/upstash` provides
`RedisTaskStore`, `QStashDispatcher` and `WorkflowDispatcher`, and the dispatcher owns its delivery
endpoint (`export const POST = tasks.createExecuteHandler()`). `principal` scopes tasks to their
caller, `idempotencyKey` turns a retried start into a read of the existing task, and `onSettle`
fires once per finished task.

`@upstash/mcp-toolkit/events` — MCP Events with webhook delivery, as ChatGPT ships it. Typed
`events.define(...)` handles with `emit(payload)`, `events/list`, `events/subscribe` and
`events/unsubscribe` registered on your server, a signed verification challenge, deterministic
subscription ids, expiry and refresh, SSRF checks on callback URLs, and signing secrets encrypted
at rest. It ships `RedisSubscriptionStore` and `QStashDelivery` in the same entry point; the latter signs each
attempt with Standard Webhooks and lets QStash retry failures (`export const POST =
events.createDeliveryHandler()`). `taskFinishedEvent` bridges the two, so an event-capable host can
stop polling.
