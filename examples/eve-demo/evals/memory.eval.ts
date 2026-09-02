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
 * Scan the memory key space for the document this run captured and return its text. eve derives the
 * scope key itself (an opaque digest of namespace + principal), so the eval can't address the key
 * directly — it looks for its own nonce instead, which is what makes this an assertion about
 * persisted state rather than about the reply.
 */
async function findPersistedMemory(redis: Redis): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, { match: "agentkit:memory:*", count: 500 });
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

    // 1. Capture through the slot's own tool: eve resolves the scope, binds `recall__save_memory`
    //    to it, and the write lands in AgentMemory under that scope's key.
    await t.send(`NOTE: ${FACT}`);
    t.succeeded();
    t.calledTool("recall__save_memory");

    // 2. The capture really reached Redis — read the stored document straight out of the database
    //    rather than trusting that the turn didn't throw. The nonce pins it to THIS run.
    t.check(await findPersistedMemory(redis), includes(NONCE));

    // 3. Automatic recall — no tool call involved: eve runs the provider's `turn.started` handler
    //    and injects the ranked block before the model sees anything. The retry is insurance
    //    against Redis Search indexing lag (each t.send is a fresh turn, i.e. a fresh recall).
    let recalled = "";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await t.send("What colour do I like?");
      recalled = t.reply ?? "";
      if (recalled.includes(NONCE)) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    // The reply is the mock model echoing the memory context eve injected before it ran, so this
    // closes the loop: captured → persisted in Redis → recalled back into the model's prompt.
    t.check(recalled, includes("Recalled memories for recall"));
    t.check(recalled, includes("teal"));
    t.check(recalled, includes(NONCE));

    // 4. eve's own file memory, stored in Redis: the model saves through `profile__save_memory`.
    await t.send("REMEMBER: The user's deploy target is Vercel.");
    t.succeeded();
    t.calledTool("profile__save_memory");

    // 5. The saved document comes back in the next turn's recalled context.
    await t.send("Anything else you know?");
    t.check(t.reply, includes("Persistent memories for profile"));
    t.check(t.reply, includes("deploy target is Vercel"));
  },
});
