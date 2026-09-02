import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    sandbox: "src/sandbox.ts",
    memory: "src/eve-memory.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
});
