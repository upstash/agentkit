import { defineMemorySaveTool } from "@upstash/agentkit-eve";

// Lets the agent persist a durable fact about the user (a preference, identity,
// goal, …) so a later turn can recall it with `recall_memory`. Same namespace as
// the recall tool so they read/write the same memory.
// `defineMemorySaveTool` calls eve's `defineTool` internally, so export it directly.
// `redis` is omitted, so the helper defaults to Redis.fromEnv() on its own.
export default defineMemorySaveTool({
  namespace: (_, ctx) => ctx.session.id, // required: per-session memory; derived from the eve context
});
