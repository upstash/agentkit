import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Every tsup entry must be reachable through `package.json#exports`, and every export must point at
// a built entry. A subpath that is built but not exported only fails for consumers ("Can't resolve
// '@upstash/agentkit-tanstack-ai/persistence'"), never in this package's own tests.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  exports: Record<string, { types: string; import: string }>;
};

// Loaded at runtime: the config sits outside `src`, so a static import would leave tsc's rootDir.
const tsupConfig = (await import(new URL("../tsup.config.ts", import.meta.url).href)) as {
  default: { entry: Record<string, string> };
};
const entries = Object.keys(tsupConfig.default.entry);

describe("package exports", () => {
  it("exports every built entry, and nothing that is not built", () => {
    const expected = Object.fromEntries(
      entries.map((name) => [
        name === "index" ? "." : `./${name}`,
        { types: `./dist/${name}.d.ts`, import: `./dist/${name}.js` },
      ]),
    );
    expect(pkg.exports).toEqual(expected);
  });
});
