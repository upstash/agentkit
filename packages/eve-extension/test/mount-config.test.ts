import { describe, expect, test } from "vitest";
import agentkit from "../extension/extension";

/**
 * Every config field is optional, so the README's smallest mount is a bare `agentkit()`. eve types
 * `ExtensionHandle`'s call signature with a *required* argument regardless, which made that mount
 * fail `tsc` with TS2554, so `extension.ts` re-types the default export with an optional parameter.
 * This file guards both halves of that: the zero-argument call has to compile (the package's
 * `typecheck` script covers `test/`) and still produce a mounted extension, and a config that *is*
 * passed has to keep being validated field by field.
 */
const MOUNTED_EXTENSION = Symbol.for("eve.mounted-extension");

describe("mount factory", () => {
  test("mounts with no config at all", () => {
    const mounted = agentkit();

    expect(Object.getOwnPropertySymbols(mounted)).toContain(MOUNTED_EXTENSION);
    expect(agentkit.config).toEqual({});
  });

  test("mounts with an empty config object", () => {
    expect(Object.getOwnPropertySymbols(agentkit({}))).toContain(MOUNTED_EXTENSION);
  });

  test("still validates the fields it is given", () => {
    // @ts-expect-error — an optional parameter must not weaken per-field type checking
    expect(() => agentkit({ memory: { topK: "nope" } })).toThrow(/Invalid extension config/);
  });
});
