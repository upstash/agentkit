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
  `tools/`, `channels/`, `connections/`, `skills/`, `schedules/`, `subagents/`,
  `hooks/`, and optional instruction fragments (eve ≥0.41 supports the full set;
  channels keep their route paths and schedules their cron expressions). Names
  come from file paths; the mount supplies the namespace, so name tools for what
  they do (`search`, not `crm_search`).
- The extension **root** cannot declare agent configuration (`agent.ts`), a
  `sandbox/`, or nested `extensions/` — those belong to the consuming agent. A
  subagent contributed under `extension/subagents/<id>/` may still own its own
  agent config and sandbox.

## Build and publish

`eve extension build` (wired to `build`/`prepare`) transforms the complete
agent-shaped source tree into `dist/extension/`, emits type declarations and a
compatibility manifest, and fills the package `exports` map. Ship `dist/` only.
`eve` is a required peer so the consumer's eve is the one that runs, but NOT a
wildcard: keep the floor (`>=0.45.1`) in sync with what the built manifest's
contracts require, so an incompatible eve fails at install instead of at
`eve build` (see issue #22). eve validates the real compatibility from the
generated manifest.
