# eve Extension Package

This package is an eve extension — a reusable package of tools, connections,
skills, hooks, and instruction fragments that a consuming agent mounts under
`agent/extensions/`.

Before writing code, read the Extensions guide from the installed eve package
docs. In most installs, those docs are at `node_modules/eve/docs/extensions.md`.
In workspaces or local package installs, resolve the installed `eve` package
location first and read its `docs/extensions.md`. If package docs are
unavailable, use https://eve.dev/docs/extensions as a fallback.

## Authoring

- Declare the extension in `extension/extension.ts` with `defineExtension` from
  `eve/extension`. Config is optional; read bound values via the handle's
  `.config` in tools and hooks.
- Add contributions under `extension/` the same way as in an agent:
  `tools/`, `connections/`, `skills/`, `hooks/`, and optional instruction
  fragments. Names come from file paths; the mount supplies the namespace, so
  name tools for what they do (`search`, not `crm_search`).
- An extension cannot declare `agent.ts`, `sandbox`, `schedules`, or nested
  `extensions/` — those belong to the consuming agent.

## Build and publish

`eve extension build` (wired to `build`/`prepare`) compiles the mount factory
and tool re-exports into `dist/` and fills the package `exports` map. Ship both
`extension/` (source the consumer recompiles) and `dist/`. Keep `eve` as a peer
dependency so the consumer's eve is the one that runs.
