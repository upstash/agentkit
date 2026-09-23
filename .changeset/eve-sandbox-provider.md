---
"@upstash/agentkit-eve": minor
---

feat!: port the Upstash Box sandbox to eve's sandbox **provider** API (`UpstashSandbox`), and require
`eve` `>=0.65.0` and `@upstash/box` `>=0.7.1`

eve 0.64.0 removed sandbox **backends**: the `SandboxBackend*` types `upstash()` implemented and the
object form `defineSandbox({ backend, bootstrap, onSession })` it plugged into. On eve ≥0.64,
`@upstash/agentkit-eve/sandbox` could still be imported, but nothing could use it, and its types
no longer compiled. It is replaced by an eve **sandbox provider**, used like eve's `VercelSandbox`:

```ts
// agent/sandbox.ts
import { defineSandbox } from "eve/sandbox";
import { UpstashSandbox } from "@upstash/agentkit-eve/sandbox";

export const environment = UpstashSandbox.environment({
  runtime: "node",
  async prepare(sandbox) {
    await sandbox.setNetworkPolicy("allow-all");
    await sandbox.run({ command: "sudo apt-get install -y jq" });
  },
});

export default defineSandbox(() => environment.open());
```

Migrating from `upstash()`: `bootstrap` becomes the environment's `prepare`, `onSession`'s
`use({ networkPolicy })` becomes `environment.open({ networkPolicy })`, and `revalidationKey` goes away.
The `redis`, `templatePrefix` and `enableTelemetry` options are removed: the prepared Box snapshot id is
now stored in eve's build output, so the Redis template registry is no longer needed. `name` is no
longer accepted, because every session gets its own uniquely named box.

Behaviour changes, all following eve's provider contract:

- **Prepare** runs at `eve build` and bakes eve's workspace seeds, **skills** (`$HOME/.agents/skills`,
  new) and your `prepare` hook into one Box snapshot. With nothing to bake, no box is created.
- **Resume** reattaches to the session's box and **fails if it is gone**, instead of silently creating
  an empty one; `sandbox.delete()` starts a fresh box. A deleted prepared snapshot also fails loudly
  with rebuild/redeploy guidance, instead of falling back to an empty box.
- **Commands** run over Box's streaming exec sessions: stdout and stderr are separate (previously the
  combined output was reported as stderr on failure), `env` reaches every command in a `&&` chain, and
  **a cancelled turn kills the running command** (previously it kept running). `spawn` streams output
  live instead of replaying it after exit.
- Network egress stays deny-all by default; Box keeps the policy on the box across pause/resume.

The package's `eve` peer moves `>=0.45.2` → **`>=0.65.0`** for all entry points; memory, tools, auth
and search are otherwise unchanged. `@upstash/box` (optional peer) moves `>=0.5.0` → **`>=0.7.1`**.

Verified against real Upstash Box: the full prepare → start → stop → resume → delete cycle, streaming
and kill, abort, and network policies. Also verified end to end: `eve build` plus a two-turn eval in
which eve's built-in `bash` tool read the seeded workspace, a skill and the `prepare` output, and read a
file written in turn 1 back in turn 2.
