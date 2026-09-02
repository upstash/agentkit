import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

// End-to-end check of the two Upstash Redis memory integrations wired up in agent/memory/, with no
// model provider: run with AGENTKIT_MOCK_MODEL=1 so agent.ts uses the scripted mockModel. Green
// means eve resolved both slots' scopes, called both providers at the real lifecycle boundaries,
// and put their recalled context into the model prompt — all against real Redis.
//
//   - `recall`  → redisMemory():    automatic capture at turn.completed, ranked recall at
//                                   turn.started. Nothing calls a tool to save it.
//   - `profile` → fileMemory({ backend: redisDocuments() }): eve's own provider, our storage.
export default defineEval({
  async test(t) {
    // 1. Automatic capture. The model is never asked to save anything here; the `recall` slot
    //    captures the user's message itself when the turn completes.
    await t.send("My favourite colour is teal and I commute on a Brompton.");
    t.succeeded();

    // 2. Automatic recall — normally on the very next turn: redisMemory()'s capture ends with
    //    waitIndexing(), so what it just stored is queryable straight away. The retry is insurance
    //    only (each t.send is a fresh turn, i.e. a fresh recall).
    let recalled = "";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await t.send("What colour do I like?");
      recalled = t.reply ?? "";
      if (recalled.includes("teal")) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    // The reply is the mock model echoing the memory context eve injected before it ran.
    t.check(recalled, includes("Recalled memories for recall"));
    t.check(recalled, includes("teal"));

    // 3. eve's own file memory, stored in Redis: the model saves through `profile__save_memory`.
    await t.send("REMEMBER: The user's deploy target is Vercel.");
    t.succeeded();
    t.calledTool("profile__save_memory");

    // 4. The saved document comes back in the next turn's recalled context.
    await t.send("Anything else you know?");
    t.check(t.reply, includes("Persistent memories for profile"));
    t.check(t.reply, includes("deploy target is Vercel"));
  },
});
