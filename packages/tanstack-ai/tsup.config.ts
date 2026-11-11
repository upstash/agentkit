import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    persistence: "src/persistence/index.ts",
    memory: "src/memory/index.ts",
    byok: "src/byok/index.ts",
    sandbox: "src/sandbox/index.ts",
    mcp: "src/mcp/index.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
});
