import { redisMemory } from "@upstash/agentkit-eve/memory";
import { defineMemory } from "eve/memory";

// AgentKit's own memory provider: it recalls the top-K memories that are *relevant to this turn*
// (BM25 fuzzy search over Upstash Redis Search) rather than replaying one bounded document, and it
// contributes `recall__save_memory` / `recall__forget_memory` so the model curates what it keeps.
export default defineMemory({
  description: "Everything the caller has told this agent before, recalled by relevance.",
  provider: redisMemory({
    // `redis` omitted → Redis.fromEnv() inside the package.
    topK: 5, // optional: max memories recalled per turn (default 5)
    minScore: 0.1, // optional: minimum BM25 relevance (default 0 — BM25 scores are unbounded)
    // Store each turn's transcript too, keyed by the eve session, and add `recall__read_conversation`.
    // Recalled memories are tagged `conversation=<id>`, so when a remembered *question* matches, the
    // model can pull up the exchange that answered it — without transcripts in every prompt.
    conversations: true,
    // autoCapture: true,       // default: stores each turn's user text. Set false for a
    //                          // model-curated slot — captured questions outrank curated facts on
    //                          // a BM25 query built from the user's own words (see the JSDoc).
    // maxRecallCharacters: 4_000,  // optional: budget for the recalled block (default 4,000)
    // maxMemoryCharacters: 2_048,  // optional: longest single stored memory (default 2,048)
  }),
  scope: (ctx) => ctx.session.auth.current?.principalId ?? ctx.session.id,
});
