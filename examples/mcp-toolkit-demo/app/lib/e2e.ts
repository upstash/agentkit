/**
 * Test hooks for `scripts/e2e.mjs`, off unless `MCP_TOOLKIT_E2E=1`. Never set it in a deployment.
 *
 * With it on, each task server also defines `always_fail`, and retries are cut so a failing task
 * reaches `failed` in seconds instead of after the default two-minute backoff.
 */
export const E2E = process.env.MCP_TOOLKIT_E2E === "1";

export const ALWAYS_FAIL = {
  title: "Always fail",
  description: "Always throws. Only defined for the e2e script, to test the failure path.",
} as const;

export async function alwaysFail(): Promise<never> {
  throw new Error("This task always fails (e2e).");
}
