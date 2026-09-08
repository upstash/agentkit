---
"@upstash/agentkit-eve-extension": patch
---

fix: make the mount config argument optional, so the documented `agentkit()` mount typechecks

The README's smallest mount — `export default agentkit();` — failed `tsc` with
`TS2554: Expected 1 arguments, but got 0`, even though every field of the config schema is
optional. eve types `ExtensionHandle`'s call signature as `(values: InferInput<S>)`, a
*required* parameter, regardless of how optional the schema is, and a required parameter
can't be omitted in TypeScript even when its type admits `undefined`. `eve build` doesn't
typecheck the mount file, so this only bit consumers running `tsc` or reading the error in
their editor; `agentkit({})` was the (undocumented) workaround.

The default export is now typed with the config parameter optional
(`(config?: AgentkitConfig) => MountedExtension`), keeping eve's `config`/`schema` members.
Nothing changes at runtime — eve's `defineExtension` already validates `values ?? {}`, so a
zero-argument mount was always fine at runtime, and field-level type checking of a passed
config is unchanged. Guarded by a new `test/mount-config.test.ts`, which the package's
`typecheck` script also compiles. Verified end to end: a real eve app mounting
`export default agentkit();` typechecks and `eve build`s with all seven tools plus the
chat-history hook contributed.
