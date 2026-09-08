import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    upstash: "src/upstash.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
});
