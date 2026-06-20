import { createRateLimitAuth } from "@upstash/agentkit-eve";
import { localDev, placeholderAuth, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({
  // eve walks `auth` in order: each entry accepts (returns a SessionAuthContext),
  // skips (returns null), or rejects (throws). createRateLimitAuth is a gate — it
  // throttles, then returns null to fall through to the real authenticators below.
  // Keys are `agentkit:rateLimit:<identifier>`.
  auth: [
    // Throttle first, before any identity check or model work.
    createRateLimitAuth({
      // `redis` omitted → defaults to Redis.fromEnv() inside the package (keeps this channel file
      // free of any agent-source import, which eve's per-channel bundle doesn't include).
      limit: 20, // optional: requests allowed per window (default 10)
      window: "1 m", // optional: sliding-window duration (default "60 s")
      identifier: "eve-demo", // optional: who to limit — a string, or (request) => string (default "global")
      // namespace: "agentkit:rateLimit", // optional: key prefix; keys are `<namespace>:<identifier>`
    }),
    // Open on localhost for `eve dev` and the REPL; ignored in production.
    localDev(),
    // Lets the eve TUI and your Vercel deployments reach the deployed agent.
    vercelOidc(),
    // This placeholder will not allow browser requests in production.
    // Replace it with your app's auth provider, like Auth.js or Clerk,
    // or use none() for a public demo.
    placeholderAuth(),
  ],
});
