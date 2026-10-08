import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "tasks/index": "src/tasks/index.ts",
    "events/index": "src/events/index.ts",
    upstash: "src/upstash.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
});
