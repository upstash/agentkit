import { defineMemoryRecallTool } from "@upstash/agentkit-eve";

import { redis } from "../redis.js";

// Lets the agent recall durable facts saved with `save_memory`. Recall is fuzzy
// (BM25) search over Upstash Redis, scoped to the namespace below.
// `defineMemoryRecallTool` calls eve's `defineTool` internally, so export it directly.
export default defineMemoryRecallTool({
  namespace: (_, ctx) => ctx.session.id, // required: per-session memory; derived from the eve context
  redis, // optional: Upstash client; defaults to Redis.fromEnv()
  topK: 5, // optional: max memories returned
  minScore: 0.1, // optional: minimum BM25 relevance score
});
