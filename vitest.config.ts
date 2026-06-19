import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    // Tests hit a real Upstash Redis whose search-index count is capped (10). Run test files
    // sequentially so concurrent index creation across packages stays well under the cap.
    fileParallelism: false,
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts", "**/types.ts"],
    },
  },
});
