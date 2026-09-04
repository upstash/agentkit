import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { withEve } from "eve/next";

// This app is a pnpm workspace member: `next` and `@upstash/agentkit-eve` live in
// `examples/eve-demo/node_modules` as symlinks into the repo-root `.pnpm` store. `@vercel/next`
// otherwise pins `outputFileTracingRoot` to this directory, which cuts the store out of the trace
// and makes Turbopack fail with "We couldn't find the Next.js package (next/package.json)".
// Both roots must be the monorepo root, and Next requires them to be equal.
const monorepoRoot = fileURLToPath(new URL("../../", import.meta.url));

const nextConfig: NextConfig = {
  outputFileTracingRoot: monorepoRoot,
  turbopack: { root: monorepoRoot },
};

export default withEve(nextConfig);
