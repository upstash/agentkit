import { redisMemory } from "@upstash/agentkit-eve/memory";
import { defineMemory } from "eve/memory";

// AgentKit's own memory provider: unlike `fileMemory()` above, it recalls the top-K memories that
// are *relevant to this turn* (BM25 fuzzy search over Upstash Redis Search) rather than replaying
// one bounded document, and it captures what the user says automatically — the model never has to
// remember to call a save tool. It also contributes `recall__save_memory` / `recall__forget_memory`
// for when the model does want explicit control.
export default defineMemory({
  description: "Everything the caller has told this agent before, recalled by relevance.",
  provider: redisMemory({
    // `redis` omitted → Redis.fromEnv() inside the package.
    topK: 5, // optional: max memories recalled per turn (default 5)
    minScore: 0.1, // optional: minimum BM25 relevance (default 0 — BM25 scores are unbounded)
    // maxCharacters: 4_000,   // optional: budget for the recalled block (default 4,000)
    // capture: false,         // optional: turn off automatic capture and curate via the tools
    // extract: (ctx) => [...] // optional: plug in your own (e.g. LLM-based) fact extraction
  }),
  scope: (ctx) => ctx.session.auth.current?.principalId ?? ctx.session.id,
});
