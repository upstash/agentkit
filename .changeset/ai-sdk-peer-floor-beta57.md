---
"@upstash/agentkit-ai-sdk": patch
---

fix: raise the `ai` peer floor from `>=7.0.0-beta` to `>=7.0.0-beta.57`

The published type declarations use `ToolExecutionOptions<...>` with a type argument, which `ai`
7.0.0-beta.56 and earlier declare as non-generic, so a TypeScript consumer on those betas got
`TS2315: Type 'ToolExecutionOptions' is not generic` from this package's `dist/index.d.ts`.
`7.0.0-beta.57` is the first release that typechecks (verified with `skipLibCheck: false` through
the current `ai@7.0.127`). No code changed.
