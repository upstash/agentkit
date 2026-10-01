import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    persistence: "src/persistence/index.ts",
    memory: "src/memory/index.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
});
