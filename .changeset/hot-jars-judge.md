---
"@upstash/mcp-tasks": minor
---

Let the dispatcher own its delivery endpoint, and give the retry budget a chance to outlast a
restart.

`TaskDispatcher` gains an optional `createExecuteHandler(run)`, surfaced as
`tasks.createExecuteHandler()`. Verifying the QStash signature, reading the task id, counting which
attempt this is and picking the status code that decides whether QStash retries are all facts about
the transport, so the transport now supplies the endpoint: an app route is
`export const POST = tasks.createExecuteHandler()` instead of a hand-written handler that has to
remember `Receiver.verify`. Modelled on Vercel Workflow's `Queue.createQueueHandler`.

Retry defaults are re-tuned around a constraint worth knowing: QStash caps `retries` per plan, and
the local dev server and free tier reject anything above 5. So the budget is bought with backoff
rather than attempts — `DEFAULT_RETRY_DELAY` is now `min(pow(3, retried) * 1000, 300000)`, spreading
five attempts over roughly two minutes instead of ten seconds. A budget shorter than a restart is
how a task ends up dead-lettered while still reading `working`.
