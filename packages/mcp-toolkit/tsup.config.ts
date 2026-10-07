import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "tasks/index": "src/tasks/index.ts",
    "tasks/upstash": "src/tasks/upstash.ts",
    "events/index": "src/events/index.ts",
    "events/upstash": "src/events/upstash.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
});
