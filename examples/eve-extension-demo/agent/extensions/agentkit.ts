import { s } from "@upstash/redis";
import agentkit from "@upstash/agentkit-eve-extension";

// One mount composes every AgentKit contribution under the `agentkit` namespace (the file basename):
// the tools `agentkit__recall_memory`, `agentkit__save_memory`, `agentkit__search`,
// `agentkit__search_aggregate`, and `agentkit__search_count`, the chat-history hook (on by default —
// every message is persisted to Upstash Redis), and a memory instructions fragment.
//
// To drop a contribution, mount as a directory instead and disable its slot — see the
// @upstash/agentkit-eve-extension README.
export default agentkit({
  // Static for this single-user demo. In production derive the tenant per call, e.g.
  // `(ctx) => ctx.session.auth.current?.principalId ?? ctx.session.id`.
  userId: "demo-user",
  search: {
    // Same schema + index the eve-demo seeds (an Upstash database caps at 10 search indexes,
    // so the demos share one books index).
    schema: s.object({ title: s.string(), author: s.string().noTokenize(), year: s.number() }),
    indexName: "eve-demo-books",
  },
});
