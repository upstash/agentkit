---
"@upstash/agentkit-eve": minor
---

fix!: correct the `eve` peer floor to `>=0.45.2` — `0.9.0` declares an eve range its own `./memory`
subpath cannot run on

`0.9.0` declares `eve: ">=0.32.0"`, but the `@upstash/agentkit-eve/memory` subpath it shipped
imports `eve/memory` and `eve/memory/file`, which eve added in **0.45.1** and **0.45.2**. So on any
eve from 0.32.0 through 0.45.1 the install succeeds — the declared range says it is fine — and then
the first `import { redisMemory } from "@upstash/agentkit-eve/memory"` dies at module load with
`ERR_PACKAGE_PATH_NOT_EXPORTED: Package subpath './memory/file' is not defined by "exports" in
.../eve/package.json`. Nothing catches it earlier: npm has no complaint to make, and `tsc` with
`skipLibCheck: true` — what the `eve` scaffold ships — type-checks the app clean. Only with
`skipLibCheck: false` do the two `TS2307: Cannot find module 'eve/memory'` / `'eve/memory/file'`
errors surface from `dist/memory.d.ts`.

The peer moves `">=0.32.0"` → `">=0.45.2"`, so that install is now the error it always should have
been. Verified on real installs of the published `0.9.0`: eve 0.45.1 fails, eve 0.45.2 imports the
subpath fine.

**This is the range being corrected, not the code being restricted — no runtime behaviour changed.**
The root `.` (`defineSearchTools`, `defineCachedTool`, `defineMemoryRecallTool` /
`defineMemorySaveTool`, `createRateLimitAuth`) and `./sandbox` (`upstash()`) entry points still load
and type-check on eve as far back as 0.32.0, exactly as they did in `0.9.0`; a package has one peer
range for its whole public surface, so it has to name the highest floor any entry point needs. If
you only use those entry points and are pinned below eve 0.45.2, `0.9.0` keeps working — you will
just see a peer warning on install, or stay on `0.9.0`.

`@upstash/agentkit-eve-extension` is untouched: its own `eve` floor (`>=0.63.0`) is set by its built
extension manifest and is already correct.
