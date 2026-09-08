---
"@upstash/agentkit-eve": minor
---

fix!: raise the `eve` peer floor to `>=0.45.2` so `@upstash/agentkit-eve/memory` can't be installed onto an eve that cannot load it

The published `0.9.0` declares `"eve": ">=0.32.0"`, a floor that was set back when the package only
exposed `.` and `./sandbox` — both of which really do work that far back. `0.9.0` is the release
where `./memory` first shipped, and that subpath is different: `dist/memory.js` contains a **runtime**
`import { MemoryDocumentConflictError } from "eve/memory/file"`, and `dist/memory.d.ts` imports
`MemoryProvider` and the four lifecycle context types from `eve/memory`. eve only added
`eve/memory` in 0.45.1 and `eve/memory/file` in 0.45.2.

So on any eve the old floor admitted below 0.45.2, `npm install` succeeds with no peer warning and the
first import dies:

```
Package subpath './memory/file' is not defined by "exports" in node_modules/eve/package.json
imported from node_modules/@upstash/agentkit-eve/dist/memory.js
```

Reproduced against the published `0.9.0` on eve 0.44.3, 0.45.0 and 0.45.1 (`ERR_PACKAGE_PATH_NOT_EXPORTED`
at runtime; `tsc` fails the same way on `eve/memory`, `eve/memory/scope` and `eve/memory/file`), and
clean on 0.45.2 / 0.47.6 / 0.48.0 / 0.49.0 / 0.50.0 / 0.51.1 / 0.52.0 / 0.52.2 — runtime import and
typecheck of `defineMemory({ provider: redisMemory() })` plus `fileMemory({ backend: redisDocuments() })`
agree on the same cut. `>=0.45.2` is therefore the exact floor: nothing in the shipped `dist` needs a
newer eve, so the root tools and the `./sandbox` backend keep working everywhere from 0.45.2 up to the
current 0.52.2.

This matters more than it used to because eve 0.52.0 moved AgentKit into its **memory-provider**
registry — `eve add memory/upstash-agentkit` now installs this package and scaffolds a slot backed by
`redisMemory()`, so `./memory` is the entry point eve itself points people at.

No source behaviour changed; only the declared peer range (plus the README and doc comments that
described the old one). If you are on eve ≥ 0.45.2 — which you are if you are on any release eve
currently supports — nothing about this release affects you.
