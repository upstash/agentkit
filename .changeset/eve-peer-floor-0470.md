---
"@upstash/agentkit-eve": patch
---

fix(eve): correct the `eve` peer floor to `>=0.47.0` — `>=0.32.0` was never satisfiable

Manifest-only fix; no source, no `dist` and no API change. The declared `eve` peer range has been
`">=0.32.0"` since long before the package could actually work on eve 0.32, because two of its entry
points import eve APIs that did not exist yet:

- `src/sandbox.ts` imports the type `SandboxDeleteOptions` from `eve/sandbox`. eve **0.47.0** made
  `delete(options?: SandboxDeleteOptions)` a required member of `SandboxBackendHandle` and added the
  type alongside it; no eve from 0.32.0 through 0.46.1 exports it (checked against the unpacked
  `dist` of 0.32.0, 0.36.0, 0.40.0, 0.44.0, 0.45.2, 0.46.0 and 0.46.1).
- `src/memory/provider.ts` and `src/memory/documents.ts` import `eve/memory`, `eve/memory/scope` and
  `eve/memory/file`. Those subpaths first appear in eve **0.45.1**/**0.45.2**; below that the runtime
  import throws `ERR_PACKAGE_PATH_NOT_EXPORTED`.

`>=0.47.0` is the lowest floor that covers both, so it is what the package now declares. Installing
this package alongside an eve below 0.47.0 will fail at install time rather than at typecheck or at
first import — which is the whole point of a floored peer.

Nothing changes for consumers on a supported eve: the package's behaviour, exports and types are
byte-identical, and it typechecks and builds clean against eve 0.54.3.
