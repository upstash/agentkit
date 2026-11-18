import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Redis } from "@upstash/redis";
// The last published version, installed under an alias: it writes the data and creates the indexes
// an existing user has before upgrading.
import { AgentMemory as OldAgentMemory, ChatHistory as OldChatHistory } from "agentkit-sdk-0.9";
import { ChatHistory } from "./chat-history.js";
import { AgentMemory } from "./memory.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniquePrefix } from "./test-support.js";

/** Poll a read until it reflects just-written docs — insurance for residual indexing lag. */
async function pollUntil<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000;
  let value = await read();
  while (!ready(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    value = await read();
  }
  return value;
}

/** Run what an error tells the user to: every `SEARCH.DROP <index>` in its message. */
async function followDropInstructions(redis: Redis, error: unknown): Promise<string[]> {
  const names = [...String(error).matchAll(/SEARCH\.DROP (\w+)/g)].map((m) => m[1] as string);
  if (!names.length) throw new Error(`no SEARCH.DROP instruction in: ${String(error)}`);
  for (const name of names) await redis.search.index({ name }).drop();
  return names;
}

/**
 * A Free-plan database (one search index), opted in with `UPSTASH_REDIS_FREE_REST_URL` and
 * `UPSTASH_REDIS_FREE_REST_TOKEN`. It must have no other search index. The test creates and drops
 * the `agentkit` indexes there and deletes the keys it writes.
 */
const freeUrl = process.env.UPSTASH_REDIS_FREE_REST_URL;
const freeToken = process.env.UPSTASH_REDIS_FREE_REST_TOKEN;
const DEFAULT_INDEXES = ["agentkit", "agentkit_memory", "agentkit_chat"];

const message = (text: string) => ({ role: "user", parts: [{ type: "text", text }] });

// Upgrading from @upstash/agentkit-sdk 0.9.0 on a database it already wrote to, then doing what the
// errors and the changeset say. The custom-prefix and default-settings cases run on the test
// database, which allows several indexes; the Free-plan case needs a one-index database of its own.
describe.skipIf(!hasRedisCreds)("upgrade from 0.9.0 (live Redis)", { timeout: 120_000 }, () => {
  const redis = testRedis();
  const prefix = uniquePrefix("migrate");
  const userId = `migrate-${randomUUID().slice(0, 8)}`;

  afterAll(async () => {
    await cleanupKeys(redis, prefix);
    await cleanupKeys(redis, `agentkit:memory:${userId}`);
    await cleanupKeys(redis, `agentkit:chat:${userId}`);
    // The custom-prefix case's own indexes (the memory one is dropped by the test already).
    for (const name of [`${prefix}:memory`, `${prefix}:chat`]) {
      await redis.search
        .index({ name: name.replace(/\W/g, "_") })
        .drop()
        .catch(() => {});
    }
  });

  it("custom prefix: the old memory index fails with SEARCH.DROP, and after the drop recall works", async () => {
    // Index names come from the unique prefix, so they never collide with other runs.
    const memoryPrefix = `${prefix}:memory`;
    const chatPrefix = `${prefix}:chat`;

    // 0.9.0: writes, and its first read creates its TEXT index.
    const old = new OldAgentMemory({ redis, prefix: memoryPrefix });
    await old.add({ userId, text: "The user is vegetarian." });
    await old.add({ userId, text: "The user lives in Lisbon." });
    expect(
      (
        await pollUntil(
          () => old.recall({ userId }),
          (hits) => hits.length === 2,
        )
      ).length,
    ).toBe(2);

    // This version: the memory index needs a HYBRID field, so the first read says what to do.
    const memory = new AgentMemory({ redis, prefix: memoryPrefix });
    const error = await memory.recall({ userId, query: "food" }).catch((e: unknown) => e);
    expect(String(error)).toMatch(/different definition/);
    expect(await followDropInstructions(redis, error)).toEqual([memoryPrefix.replace(/\W/g, "_")]);

    // Same instance, after the drop: the old documents are indexed again, and recall is hybrid.
    await memory.count({ userId }); // creates the index
    await memory.searchIndex.waitIndexing(); // the new index embeds the old documents first
    const all = await pollUntil(
      () => memory.recall({ userId }),
      (hits) => hits.length === 2,
    );
    expect(all.map((h) => h.text).sort()).toEqual([
      "The user is vegetarian.",
      "The user lives in Lisbon.",
    ]);
    // No word in common with either memory, so only the semantic half of hybrid recall can rank.
    const byMeaning = await memory.recall({ userId, query: "dietary restrictions", topK: 1 });
    expect(byMeaning[0]?.text).toBe("The user is vegetarian.");
    await memory.searchIndex.index.drop();

    // A custom-prefix chat index has the same definition as before: no error, old chats still there.
    const oldChats = new OldChatHistory({ redis, prefix: chatPrefix });
    await oldChats.saveChat({ userId, sessionId: "s1", messages: [message("Hello from 0.9")] });
    expect(
      (
        await pollUntil(
          () => oldChats.listChats({ userId }),
          (rows) => rows.length > 0,
        )
      ).length,
    ).toBe(1);
    const chats = new ChatHistory({ redis, prefix: chatPrefix });
    expect((await chats.listChats({ userId })).map((c) => c.sessionId)).toEqual(["s1"]);
  });

  it("default settings: old data is found through the shared index, and the old indexes can go", async () => {
    // 0.9.0 defaults: `agentkit_memory` over `agentkit:memory:`, `agentkit_chat` over `agentkit:chat:`.
    const old = new OldAgentMemory({ redis });
    await old.add({ userId, text: "The user is vegetarian." });
    const oldChats = new OldChatHistory({ redis });
    await oldChats.saveChat({
      userId,
      sessionId: "old",
      messages: [message("I am vegetarian, what should I cook?")],
    });
    await pollUntil(
      () => old.recall({ userId }),
      (hits) => hits.length > 0,
    );
    await pollUntil(
      () => oldChats.listChats({ userId }),
      (rows) => rows.length > 0,
    );

    // This version, default settings: one `agentkit` index over both prefixes.
    const memory = new AgentMemory({ redis });
    const chats = new ChatHistory({ redis });
    const check = async () => {
      await memory.searchIndex.waitIndexing();
      // The 0.9.0 chat (no `kind`) is still a chat, and never a memory.
      const listed = await pollUntil(
        () => chats.listChats({ userId }),
        (rows) => rows.length > 0,
      );
      expect(listed.map((c) => c.sessionId)).toEqual(["old"]);
      const memories = await pollUntil(
        () => memory.list({ userId }),
        (rows) => rows.length > 0,
      );
      expect(memories.map((m) => m.text)).toEqual(["The user is vegetarian."]);
      expect(await memory.count({ userId })).toBe(1);
      const recalled = await pollUntil(
        () => memory.recall({ userId, query: "What food should I cook?", topK: 5 }),
        (hits) => hits.length > 0,
      );
      expect(recalled.map((h) => h.text)).toEqual(["The user is vegetarian."]);
    };
    await check();

    // The changeset: the old default indexes are no longer used and can be dropped.
    await redis.search
      .index({ name: "agentkit_memory" })
      .drop()
      .catch(() => {});
    await redis.search
      .index({ name: "agentkit_chat" })
      .drop()
      .catch(() => {});
    await check();
  });

  it.skipIf(!freeUrl || !freeToken)(
    "Free plan: the 0.9.0 index fills the only slot, and after the drops everything works",
    async () => {
      // A user who ran 0.9.0 with default settings on a Free-plan database.
      const free = new Redis({ url: freeUrl!, token: freeToken! });
      // Never drop an index this test did not create.
      for (const name of DEFAULT_INDEXES) {
        expect(
          await free.search.index({ name }).describe(),
          `index ${name} already exists`,
        ).toBeNull();
      }
      try {
        const old = new OldAgentMemory({ redis: free });
        await old.add({ userId, text: "The user is vegetarian." });
        await pollUntil(
          () => old.recall({ userId }),
          (hits) => hits.length > 0,
        ); // creates `agentkit_memory`, the database's only index
        await new OldChatHistory({ redis: free }).saveChat({
          userId,
          sessionId: "old",
          messages: [message("I am vegetarian, what should I cook?")],
        });

        // This version needs the `agentkit` index, and there is no slot for it.
        const memory = new AgentMemory({ redis: free });
        const chats = new ChatHistory({ redis: free });
        const error = await memory.recall({ userId, query: "food" }).catch((e: unknown) => e);
        expect(String(error)).toMatch(/no index slots left/);
        await expect(chats.listChats({ userId })).rejects.toThrow(/no index slots left/);

        // Do what the error says; the same instances then work, on the data 0.9.0 wrote.
        expect(await followDropInstructions(free, error)).toEqual([
          "agentkit_memory",
          "agentkit_chat",
        ]);
        const recalled = await pollUntil(
          () => memory.recall({ userId, query: "What food should I cook?", topK: 5 }),
          (hits) => hits.length > 0,
        );
        expect(recalled.map((h) => h.text)).toEqual(["The user is vegetarian."]);
        expect(await memory.count({ userId })).toBe(1);
        const listed = await pollUntil(
          () => chats.listChats({ userId }),
          (rows) => rows.length > 0,
        );
        expect(listed.map((c) => c.sessionId)).toEqual(["old"]);
        await memory.add({ userId, text: "The user lives in Lisbon." });
        await memory.searchIndex.waitIndexing(); // a new HYBRID document is embedded before it is found
        expect(
          (
            await pollUntil(
              () => memory.list({ userId }),
              (rows) => rows.length === 2,
            )
          ).length,
        ).toBe(2);
      } finally {
        for (const name of DEFAULT_INDEXES) {
          await free.search
            .index({ name })
            .drop()
            .catch(() => {});
        }
        await cleanupKeys(free, `agentkit:memory:${userId}`);
        await cleanupKeys(free, `agentkit:chat:${userId}`);
      }
    },
  );
});
