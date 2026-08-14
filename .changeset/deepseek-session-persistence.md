---
"@upstash/agentkit-deepseek": minor
---

Add `@upstash/agentkit-deepseek`: a durable DeepSeek Harness session-persistence backend on Upstash
Redis.

It registers as `ctx.sessionPersistence` and is a drop-in replacement for the harness's shipped JSONL
and SQLite backends, so a serverless or multi-replica deployment — which has no durable local disk to
write sessions to and no shared one to read them back — can still persist and resume them.

Like the first-party backends it composes the shared `PersistenceCoordinator` and implements only the
`PersistenceBackend` storage hooks, and it passes the harness's own backend-agnostic conformance
suite against a real Upstash Redis. Sessions are stored as a Redis list indexed by event seq, which
makes it seek-capable (`readFrom` reads only the requested suffix); appends and repairs each run as a
single Lua script, giving the atomic materialize-plus-first-batch the seam requires.

The package ships a `dsh.bundle` layer, so `dsh plugin add @upstash/agentkit-deepseek` both installs
and activates it.

Credentials resolve through the harness's `ctx.credentials` seam before falling back to
`Redis.fromEnv()`, so the managed `~/.dsh/.credentials.yaml` store — which is deliberately never
materialized into `process.env` — works. Config names the reference (`urlRef`/`tokenRef`), never the
value. The package also ships an `agentkit-deepseek` command (`credentials set` / `credentials
status`) that writes that store through the harness's own provider, so no file has to be hand-edited:

```bash
dsh plugin --profile web exec agentkit-deepseek credentials set
```
