import { Redis } from "@upstash/redis";
import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

// End-to-end check of the two Upstash Redis memory integrations wired up in agent/memory/, with no
// model provider: run with AGENTKIT_MOCK_MODEL=1 so agent.ts uses the scripted mockModel. Green
// means eve resolved both slots' scopes, called both providers at the real lifecycle boundaries,
// put their recalled context into the model prompt, and left the memory in Redis — all against a
// real database.
//
//   - `recall`  → redisMemory():    the model saves through `recall__save_memory`, then eve recalls
//                                   the top-K relevant memories at turn.started. (`rememberMessages`
//                                   also captures each turn automatically — see agent/memory/.)
//   - `profile` → fileMemory({ backend: redisDocuments() }): eve's own provider, our storage.

/** Tags this run's memory so the assertions can't pass on a document an earlier run left behind. */
const NONCE = `run-${Date.now().toString(36)}`;
const FACT = `My favourite colour is teal, I commute on a Brompton, and my tag is ${NONCE}.`;

/**
 * Scan the slot's own key space for the document this run captured and return its text. The slot
 * stores under `agentkit:memorySlot:` rather than the shared `agentkit:memory:` — its schema carries
 * extra indexed fields, and such a schema must not cover a keyspace holding records written without
 * them. eve derives the
 * scope key itself (an opaque digest of namespace + principal), so the eval can't address the key
 * directly — it looks for its own nonce instead, which is what makes this an assertion about
 * persisted state rather than about the reply.
 */
async function findPersistedMemory(redis: Redis): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, { match: "agentkit:memorySlot:*", count: 500 });
      cursor = next;
      for (const key of keys) {
        const document = (await redis.json.get(key)) as { text?: unknown } | null;
        if (typeof document?.text === "string" && document.text.includes(NONCE)) {
          return document.text;
        }
      }
    } while (cursor !== "0");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return "";
}

export default defineEval({
  async test(t) {
    const redis = Redis.fromEnv();

    // One explicit session for the whole conversation. On eve ≥0.59 a bare `t.send` opens a
    // FRESH session per call, and the mock model in agent/agent.ts is prompt-aware — it counts
    // `userMessages` against completed `toolResults` in the accumulated conversation — so the five
    // turns below must share one session or the script would be testing something else.
    const session = await t.session();

    // 1. Capture through the slot's own tool: eve resolves the scope, binds `recall__save_memory`
    //    to it, and the write lands in AgentMemory under that scope's key.
    const noted = await session.send(`NOTE: ${FACT}`);
    noted.succeeded();
    noted.calledTool("recall__save_memory");

    // 2. The capture really reached Redis — read the stored document straight out of the database
    //    rather than trusting that the turn didn't throw. The nonce pins it to THIS run.
    t.check(await findPersistedMemory(redis), includes(NONCE));

    // 3. Automatic recall — no tool call involved: eve runs the provider's `turn.started` handler
    //    and injects the ranked block before the model sees anything. The retry is insurance
    //    against Redis Search indexing lag (each session.send is a fresh turn, i.e. a fresh recall).
    let recalled = "";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const turn = await session.send("What colour do I like?");
      recalled = turn.message ?? "";
      if (recalled.includes(NONCE)) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    // The reply is the mock model echoing the memory context eve injected before it ran, so this
    // closes the loop: captured → persisted in Redis → recalled back into the model's prompt.
    t.check(recalled, includes("Recalled memories for recall"));
    t.check(recalled, includes("teal"));
    t.check(recalled, includes(NONCE));

    // 4. eve's own file memory, stored in Redis: the model saves through `profile__save_memory`.
    const remembered = await session.send("REMEMBER: The user's deploy target is Vercel.");
    remembered.succeeded();
    remembered.calledTool("profile__save_memory");

    // 5. The saved document comes back in the next turn's recalled context.
    const recap = await session.send("Anything else you know?");
    t.check(recap.message, includes("Persistent memories for profile"));
    t.check(recap.message, includes("deploy target is Vercel"));
  },
});
