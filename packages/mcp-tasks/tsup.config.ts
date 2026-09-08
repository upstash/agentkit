import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    upstash: "src/upstash.ts",
    workflow: "src/workflow.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
});
