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
  Note: even when every config *field* is optional, eve types the mount handle's
  call signature as `(values: InferInput<S>)` — a **required** parameter — so
  `agentkit()` fails `tsc` with TS2554 and docs must show `agentkit({})`. That
  signature lives in the `eve` peer dep, not here; `.optional()` on the schema
  does not fix it (it only makes `extension.config` possibly-undefined).
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
wildcard: keep the floor (`>=0.52.2`) in sync with what the built manifest's
contracts require, so an incompatible eve fails at install instead of at
`eve build` (see issue #22). eve validates the real compatibility from the
generated manifest.

🛑 **The `eve` devDependency is frozen at 0.52.2 on purpose — do not bump it.**
0.52.2 is what the published `0.10.0` was built from, and its stamps
(tool 30 / dynamicTool 29 / hook 20) are still accepted by `eve@latest` (0.59.1),
so `0.10.0` keeps working. Rebuilding on 0.53–0.55 stamps tool 36–38 /
dynamicTool 35–37, which lands in a contract hole eve has since **dropped**: that
build installs fine but fails `eve build` with
`Selected module binding "extensions/agentkit.ts" has no compile or runtime usage.`
A bump must go to the *current* `eve@latest`, and is blocked until the repo's evals
are migrated off the API eve 0.59.0 removed (`EveEvalContext.reply`/`newSession()`
→ `await t.session()` / `turn.message`) — see `examples/eve-demo/evals/memory.eval.ts`
lines 67/84/85 and `examples/eve-extension-demo/evals/agentkit-smoke.eval.ts` line 14,
and the "Eve framework facts" section of the root `CLAUDE.md`.
