import { createRateLimitAuth } from "@upstash/agentkit-eve";
import { localDev, placeholderAuth, vercelOidc, type AuthFn } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

// The UI's user dropdown sends the selected user as this header (see app/_components/agent-chat.tsx).
const USER_HEADER = "x-user-id";

// Demo-only: trust the `x-user-id` header as the session identity, so the agent's memory and cached
// tools (which read `ctx.session.auth.current.principalId`) are scoped to the selected user, and one
// user's data stays separate from another's. Returns null when the header is absent, so the walk
// falls through to the real authenticators below. **Never trust a client-supplied identity header in
// production** — replace this with your real auth provider (Auth.js, Clerk, …).
const demoUserAuth: AuthFn<Request> = (req) => {
  const userId = req.headers.get(USER_HEADER);
  if (!userId) return null;
  return { authenticator: "demo-user-header", principalId: userId, principalType: "user", attributes: {} };
};

export default eveChannel({
  // eve walks `auth` in order: each entry accepts (returns a SessionAuthContext),
  // skips (returns null), or rejects (throws). createRateLimitAuth is a gate — it
  // throttles, then returns null to fall through to the real authenticators below.
  // Keys are `agentkit:rateLimit:<identifier>`.
  auth: [
    // Throttle first, per user, before any identity check or model work.
    createRateLimitAuth({
      // `redis` omitted → defaults to Redis.fromEnv() inside the package (keeps this channel file
      // free of any agent-source import, which eve's per-channel bundle doesn't include).
      limit: 20, // optional: requests allowed per window (default 10)
      window: "1 m", // optional: sliding-window duration (default "60 s")
      // required: who to limit — the selected user (falls back to per-IP, then "anonymous").
      identifier: (req) =>
        req.headers.get(USER_HEADER) ?? req.headers.get("x-forwarded-for") ?? "anonymous",
      // prefix: "agentkit:rateLimit", // optional: base key prefix; keys are `<prefix>:<identifier>`
    }),
    // Set the session identity from the user dropdown's header (before the fallbacks below).
    demoUserAuth,
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
