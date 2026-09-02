import { redisMemory } from "@upstash/agentkit-eve/memory";
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";

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
  // Scope memory to the authenticated principal. `byPrincipal` fails **closed**: it returns null
  // for anonymous/runtime callers, which disables the slot rather than pooling everyone into one
  // partition — unlike a `?? ctx.session.id` fallback, which silently degrades the boundary.
  // Here the principal comes from `demoUserAuth` (the `x-user-id` header from the UI's dropdown),
  // which runs before `localDev()` in agent/channels/eve.ts, so alice and bob stay separate in the
  // browser while the eve TUI — which sends no header — gets the shared `local-dev` principal.
  // ⚠ That header is demo-only: anyone can set it. Never derive a scope from an unverified header
  // (or from model input) in production — the scope IS the tenant boundary.
  scope: byPrincipal,
});
