---
"@upstash/agentkit-eve": minor
---

feat(eve/sandbox): implement the `delete()` sandbox-handle method (eve 0.47)

eve 0.47.0 added a required `delete(options?: SandboxDeleteOptions)` to
`SandboxBackendHandle`, so the Box-backed handle stopped satisfying the interface
(`TS2741: Property 'delete' is missing …`). It now implements it: `delete()` calls
`box.delete()` — Upstash Box's permanent teardown — instead of the `box.pause()`
that `stop()`/`shutdown()` use to keep the box reattachable. Per eve's contract it
destroys only *disposable* state: the prewarmed template snapshot and its Redis
`templateKey → snapshotId` registry entry are left intact, so eve provisions the
session's replacement box from the same template. Provider errors reject (eve then
preserves the reconnect state for a retry), `options.abortSignal` is honoured before
the call, and a deleted handle turns further `delete`/`stop`/`shutdown` calls into
no-ops (eve still pauses deleted handles at server shutdown).

The `eve` devDependency of `packages/eve` moves to `^0.47.3`. The `eve` peer range
stays `>=0.32.0`: the built `dist` names no post-0.32 type and was re-verified against
eve 0.32.0 and 0.46.1.
