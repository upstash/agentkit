import { defineMemorySaveTool } from "@upstash/agentkit-eve";

import { redis } from "../redis.js";

// Lets the agent persist a durable fact about the user (a preference, identity,
// goal, …) so a later turn can recall it with `recall_memory`. Same namespace as
// the recall tool so they read/write the same memory.
// `defineMemorySaveTool` calls eve's `defineTool` internally, so export it directly.
export default defineMemorySaveTool({
  namespace: (_, ctx) => ctx.session.id, // required: per-session memory; derived from the eve context
  redis, // optional: Upstash client; defaults to Redis.fromEnv()
});
