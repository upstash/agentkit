import { Redis } from "@upstash/redis";
import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

// End-to-end check of the Upstash Redis memory integration wired up in agent/memory/, with no model
// provider: run with AGENTKIT_MOCK_MODEL=1 so agent.ts uses the scripted mockModel. Green means eve
// resolved the slot's scope, called the provider at the real lifecycle boundaries, put its recalled
// context into the model prompt, and left the document in Redis — all against a real database.
//
//   - `profile` → fileMemory({ backend: redisDocuments() }): eve's own provider, our storage.

/** Tags this run's memory so the assertions can't pass on a document an earlier run left behind. */
const NONCE = `run-${Date.now().toString(36)}`;
const FACT = `The user's deploy target is Vercel and their tag is ${NONCE}.`;

/**
 * Scan the memory-document key space for what this run saved and return its text. eve derives the
 * scope key itself (an opaque digest of namespace + principal), so the eval can't address the key
 * directly — it looks for its own nonce instead, which is what makes this an assertion about
 * persisted state rather than about the reply.
 */
async function findPersistedDocument(redis: Redis): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, { match: "agentkit:memoryFile:*", count: 500 });
      cursor = next;
      for (const key of keys) {
        const content = await redis.hget<string>(key, "content");
        if (typeof content === "string" && content.includes(NONCE)) return content;
      }
    } while (cursor !== "0");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return "";
}

export default defineEval({
  async test(t) {
    const redis = Redis.fromEnv();

    // 1. The model saves through eve's own `save_memory`, qualified to the slot. Our backend is
    //    what turns that call into a durable Redis write.
    await t.send(`REMEMBER: ${FACT}`);
    t.succeeded();
    t.calledTool("profile__save_memory");

    // 2. It really reached Redis — read the stored hash straight out of the database rather than
    //    trusting that the turn didn't throw. The nonce pins it to THIS run.
    t.check(await findPersistedDocument(redis), includes(NONCE));

    // 3. Recall is automatic: eve runs the provider's `turn.started` handler and injects the
    //    document before the model sees anything. The reply is the mock echoing what arrived in its
    //    prompt, which closes the loop: saved → persisted in Redis → recalled back into context.
    await t.send("Anything else you know?");
    t.check(t.reply, includes("Persistent memories for profile"));
    t.check(t.reply, includes(NONCE));
  },
});
