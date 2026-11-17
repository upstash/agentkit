import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Redis } from "@upstash/redis";
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

/** Run what an error tells the user to: `SEARCH.DROP <index>`. */
async function followDropInstruction(redis: Redis, error: unknown): Promise<string> {
  const name = /SEARCH\.DROP (\w+)/.exec(String(error))?.[1];
  if (!name) throw new Error(`no SEARCH.DROP instruction in: ${String(error)}`);
  await redis.search.index({ name }).drop();
  return name;
}

const message = (text: string) => ({ role: "user", parts: [{ type: "text", text }] });

// Upgrading from @upstash/agentkit-sdk 0.9.0 on a database it already wrote to, then doing what the
// errors and the changeset say. The test database allows more than one index, so the Free-plan path
// (the new `agentkit` index refused while `agentkit_memory` / `agentkit_chat` exist) cannot happen
// here; the default-settings case checks the data side of it.
describe.skipIf(!hasRedisCreds)("upgrade from 0.9.0 (live Redis)", () => {
  const redis = testRedis();
  const prefix = uniquePrefix("migrate");
  const userId = `migrate-${randomUUID().slice(0, 8)}`;

  afterAll(async () => {
    await cleanupKeys(redis, prefix);
    await cleanupKeys(redis, `agentkit:memory:${userId}`);
    await cleanupKeys(redis, `agentkit:chat:${userId}`);
  });

  it("custom prefix: the old memory index fails with SEARCH.DROP, and after the drop recall works", async () => {
    const memoryPrefix = `${prefix}:memory`;
    const chatPrefix = `${prefix}:chat`;

    // 0.9.0: writes, and its first reads create its TEXT indexes.
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

    // This version: the memory index needs a HYBRID field, so the first read says what to do.
    const memory = new AgentMemory({ redis, prefix: memoryPrefix });
    const error = await memory.recall({ userId, query: "food" }).catch((e: unknown) => e);
    expect(String(error)).toMatch(/SEARCH\.DROP/);
    expect(await followDropInstruction(redis, error)).toBe(memoryPrefix.replace(/\W/g, "_"));

    // Same instance, after the drop: the old documents are indexed again, and recall is hybrid.
    const all = await pollUntil(
      () => memory.recall({ userId }),
      (hits) => hits.length === 2,
    );
    expect(all.map((h) => h.text).sort()).toEqual([
      "The user is vegetarian.",
      "The user lives in Lisbon.",
    ]);
    const byMeaning = await pollUntil(
      () => memory.recall({ userId, query: "What food should I cook for them?", topK: 1 }),
      (hits) => hits.length > 0,
    );
    expect(byMeaning[0]?.text).toBe("The user is vegetarian.");

    // A custom-prefix chat index has the same definition as before: no error, old chats still there.
    const chats = new ChatHistory({ redis, prefix: chatPrefix });
    expect((await chats.listChats({ userId })).map((c) => c.sessionId)).toEqual(["s1"]);

    await redis.search.index({ name: memoryPrefix.replace(/\W/g, "_") }).drop();
    await redis.search.index({ name: chatPrefix.replace(/\W/g, "_") }).drop();
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
});
