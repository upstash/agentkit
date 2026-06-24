import { defineSandbox } from "eve/sandbox";
import { upstash } from "@upstash/agentkit-eve/sandbox";

// Gives the agent an isolated /workspace bash environment, backed by Upstash Box.
// Defining a sandbox is all it takes — eve automatically exposes the built-in
// `bash`, `read_file`, `write_file`, `glob`, and `grep` tools to the model, all
// rooted at /workspace. No custom tool wrapper is needed.
//
// This is the folder layout (agent/sandbox/sandbox.ts): files under
// agent/sandbox/workspace/ are seeded into /workspace at session start (e.g.
// workspace/README.txt lands at /workspace/README.txt).
//
// Runtime note: the Upstash Box backend reads UPSTASH_BOX_API_KEY at run time.
export default defineSandbox({
  // `upstash()` is a drop-in replacement for eve's `vercel()` backend.
  backend: upstash({
    // The Upstash Box `BoxConfig`, verbatim (whatever you'd pass to `Box.create({...})`):
    runtime: "node", // optional: Box runtime (node | python | golang | ruby | rust)
    size: "small", // optional: Box resource size (small | medium | large)
    // optional: name, apiKey (defaults to UPSTASH_BOX_API_KEY), keepAlive,
    // initCommand, env, skills, mcpServers, timeout, … — all BoxConfig fields.
    // (networkPolicy is not a config knob — egress is deny-all by default, set per-session below.)
  }),
  // optional: durable-session-scoped, runs once per session. A good place to lock
  // down the network before the agent runs any commands. (Add a `bootstrap` hook
  // for one-time template setup — it's required if you set a `revalidationKey`.)
  async onSession({ use }) {
    await use({ networkPolicy: "deny-all" }); // block all egress (incl. DNS) for this session
  },
});
