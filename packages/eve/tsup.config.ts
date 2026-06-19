import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    sandbox: "src/sandbox.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
});
