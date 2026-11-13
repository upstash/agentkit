import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { ChatHistory } from "./chat-history.js";
import { AgentMemory } from "./memory.js";
import { SHARED_INDEX_NAME } from "./shared-index.js";
import { cleanupKeys, hasRedisCreds, testRedis } from "./test-support.js";

/** Poll a read until it reflects just-written docs — insurance for residual indexing lag. */
async function pollUntil<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8_000;
  let value = await read();
  while (!ready(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    value = await read();
  }
  return value;
}

// Default configuration on purpose: this is the one index a Free-plan database can hold.
describe.skipIf(!hasRedisCreds)("shared index (live Redis)", () => {
  const redis = testRedis();
  const memory = new AgentMemory({ redis });
  const chats = new ChatHistory({ redis });
  const userId = `shared-${randomUUID().slice(0, 8)}`;

  afterAll(async () => {
    await cleanupKeys(redis, `agentkit:memory:${userId}`);
    await cleanupKeys(redis, `agentkit:chat:${userId}`);
  });

  it("keeps memories and chats in one index without mixing them", async () => {
    await memory.count({ userId }); // provision the index before seeding
    await memory.add({ userId, text: "The user lives in Lisbon." });
    await chats.saveChat({
      userId,
      sessionId: "s1",
      messages: [{ role: "user", parts: [{ type: "text", text: "I moved to Lisbon last year." }] }],
    });
    await memory.searchIndex.waitIndexing();

    expect(memory.searchIndex.index.name).toBe(SHARED_INDEX_NAME);
    expect(chats.searchIndex.index.name).toBe(SHARED_INDEX_NAME);

    const recalled = await pollUntil(
      () => memory.recall({ userId, query: "Lisbon", topK: 10 }),
      (hits) => hits.length > 0,
    );
    expect(recalled.map((h) => h.text)).toEqual(["The user lives in Lisbon."]);
    expect(await memory.count({ userId })).toBe(1);

    const listed = await pollUntil(
      () => chats.listChats({ userId }),
      (rows) => rows.length > 0,
    );
    expect(listed.map((c) => c.sessionId)).toEqual(["s1"]);
    expect((await chats.searchChats({ userId, query: "Lisbon" })).map((c) => c.sessionId)).toEqual([
      "s1",
    ]);
  });
});
