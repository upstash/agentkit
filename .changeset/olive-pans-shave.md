---
"@upstash/mcp-tasks": minor
---

Add a Workflow dispatcher, and let each transport decide when a failure is final.

`@upstash/mcp-tasks/upstash` now also exports `WorkflowDispatcher`, which runs each task as an
Upstash Workflow run — one invocation per step, with finished steps replayed from a journal. That
is the difference between surviving a crash and outliving a time limit: a QStash delivery is a
single serverless invocation, so exceeding the platform's function limit kills the work and the
redelivery restarts the handler from the beginning.

The layer is now generic over what its transport provides. `createTaskLayer<WorkflowContext>(...)`
gives handlers `TaskContext & WorkflowContext` — one object carrying both `update`/`isCancelled`
and the engine's real `run`, `sleep`, `call`, `waitForEvent` — while a queue-backed layer gives
just the `TaskContext`. Transports are not interchangeable, and the types now say so instead of
papering over it with a lowest-common-denominator shim. The SDK journals its own writes, so
`task.update(...)` is not repeated when a workflow replays the handler.

`TaskStore.update` is now ignored once a task is terminal, on both backends. The spec's "state does
not change" covers the status message, and a progress write landing after a cancel was overwriting
"Cancelled by client".

Retry bookkeeping moves out of the core. `executeTask` no longer takes `isFinalAttempt` and never
settles a task `failed`: it rethrows and leaves the task `working`, and the dispatcher calls the new
`failTask` once it has genuinely stopped retrying. QStash learns that from its own failure callback,
which fires only after every retry is exhausted and now arrives at the *same* execute endpoint —
one route, one signature check, told apart by the body. Workflow learns it from `failureFunction`.
Nothing in the package counts attempts or reads a retry header any more.

Removed: `ExecuteTaskOptions`, `TaskRunner`, `isFinalQStashAttempt`, `QSTASH_RETRIED_HEADER`, and
the public `QStashDispatcher.retries` field. Added: `TaskEndpoints`, `TaskSteps`,
`TaskDispatcher.attach`, and `TaskLayer.failTask`; `createExecuteHandler` now takes no arguments.
