import { defineSandbox } from "eve/sandbox";
import { UpstashSandbox } from "@upstash/agentkit-eve/sandbox";

// Gives the agent an isolated /workspace bash environment, backed by Upstash Box.
// Defining a sandbox is all it takes — eve automatically exposes the built-in
// `bash`, `read_file`, `write_file`, `glob`, and `grep` tools to the model, all
// rooted at /workspace. No custom tool wrapper is needed.
//
// This is the folder layout (agent/sandbox/sandbox.ts): files under
// agent/sandbox/workspace/ are baked into the environment when eve prepares it
// (e.g. workspace/README.txt lands at /workspace/README.txt).
//
// The Upstash Box provider reads UPSTASH_BOX_API_KEY when eve prepares the
// environment (at `eve build`) and at run time.

// The environment export is required: eve prepares it before any session exists.
export const environment = UpstashSandbox.environment({
  // The Upstash Box `BoxConfig`, verbatim (whatever you'd pass to `Box.create({...})`):
  runtime: "node", // optional: Box runtime (node | python | golang | ruby | rust)
  size: "small", // optional: Box resource size (small | medium | large)
  // optional: apiKey (defaults to UPSTASH_BOX_API_KEY), keepAlive, initCommand,
  // env, skills, mcpServers, attachHeaders, timeout, … — all BoxConfig fields,
  // plus `prepare(sandbox)` for setup every session inherits and `baseSnapshot`.
});

// Runs once per durable session. Egress is deny-all by default; pass a
// networkPolicy ("allow-all" or a domain allow-list) to open it.
export default defineSandbox(() => environment.open({ networkPolicy: "deny-all" }));
