import { defineConfig } from "vitest/config";

// The E2E suite: two production servers of this app, one Upstash Redis, a scripted model.
// Files are `*.e2e.ts` so the repo's unit-test run never picks them up.
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.ts"],
    globalSetup: ["e2e/servers.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
