---
"@upstash/agentkit-eve-extension": patch
---

docs: correct the README's minimal mount to `agentkit({})`

The "Mount it" example showed `export default agentkit();`, which **fails a consumer's
`tsc`** with `TS2554: Expected 1 arguments, but got 0.` — verified against the published
`0.7.0` types, and against a build of the current source. It only ever bit consumers in an
editor or running `tsc`, because `eve build` does not typecheck the mount file, and it works
at runtime: eve's `defineExtension` validates `values ?? {}`, so a zero-argument mount binds
an empty config just fine. The example is now `export default agentkit({});`, which
typechecks clean.

The required argument is **not** something this package declares. Every field of the config
schema is optional, but eve types the mount handle it returns as

```ts
export interface ExtensionHandle<S extends StandardSchemaV1 = StandardSchemaV1> {
  (values: StandardSchemaV1.InferInput<S>): MountedExtension;
  // …
}
```

— a *required* parameter, and TypeScript will not let a required parameter be omitted even
when its type admits `undefined`. That interface lives in the `eve` peer dependency, which
supplies the type at the consumer's own install, so the zero-argument form cannot be made to
typecheck from this repo: marking `defineExtension`'s `config` property optional does not
reach the handle's call signature (still `TS2554`), and `.optional()` on the config schema
does not either — it only makes `extension.config` possibly-undefined and breaks the
extension's own build. The upstream fix would be `(values?: …)` on `ExtensionHandle`; if eve
ships that, the example can go back to `agentkit()`.

Docs only — no extension source, contributions or manifest changed, so the built `dist/` and
the `eve` peer floor are untouched. This ships purely so the corrected README reaches npm.
