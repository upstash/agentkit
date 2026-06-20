import { defineMemoryRecallTool } from "@upstash/agentkit-eve";

// Lets the agent recall durable facts saved with `save_memory`. Recall is fuzzy
// (BM25) search over Upstash Redis, scoped to the namespace below.
// `defineMemoryRecallTool` calls eve's `defineTool` internally, so export it directly.
// `redis` is omitted, so the helper defaults to Redis.fromEnv() on its own.
export default defineMemoryRecallTool({
  namespace: (_, ctx) => ctx.session.id, // required: per-session memory; derived from the eve context
  topK: 5, // optional: max memories returned
  minScore: 0.1, // optional: minimum BM25 relevance score
});
