import { afterAll, describe, expect, it } from "vitest";
import { ChatHistory } from "./chat-history.js";
import { hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

interface Msg {
  id: string;
  role: "user" | "assistant";
  parts: { type: "text"; text: string }[];
}

const msg = (id: string, role: Msg["role"], text: string): Msg => ({
  id,
  role,
  parts: [{ type: "text", text }],
});

describe.skipIf(!hasRedisCreds)("ChatHistory (live Redis Search)", () => {
  const redis = testRedis();
  const history = new ChatHistory<Msg>({ redis, namespace: uniqueNamespace("chat") });
  const user = "user-1";

  afterAll(async () => {
    await history.searchIndex.drop().catch(() => {});
  });

  it("saves the full transcript and fetches it back by id", async () => {
    await history.saveChat(user, "c1", [msg("m1", "user", "hi"), msg("m2", "assistant", "hello")], {
      title: "First chat",
    });
    const got = await history.getChat(user, "c1");
    expect(got?.title).toBe("First chat");
    expect(got?.messages).toHaveLength(2);
    expect(got?.messageCount).toBe(2);

    // Overwrite with the whole conversation again (no delta merge).
    await history.saveChat(user, "c1", [
      msg("m1", "user", "hi"),
      msg("m2", "assistant", "hello"),
      msg("m3", "user", "bye"),
    ]);
    expect((await history.getChat(user, "c1"))?.messages).toHaveLength(3);
    // Title is preserved across overwrites.
    expect((await history.getChat(user, "c1"))?.title).toBe("First chat");
  });

  it("isolates chats by user", async () => {
    expect(await history.getChat("someone-else", "c1")).toBeNull();
  });

  it("lists a user's chats (filtered by userId in the index)", async () => {
    await history.saveChat(user, "c2", [msg("a", "user", "second chat")], { title: "Second" });
    await history.searchIndex.waitIndexing();

    const list = await history.listChats(user);
    const ids = list.map((c) => c.sessionId);
    expect(ids).toContain("c1");
    expect(ids).toContain("c2");
    expect(list[0]).not.toHaveProperty("messages");

    expect(await history.listChats("nobody")).toHaveLength(0);
  });

  it("fuzzily searches user/model messages", async () => {
    await history.saveChat(user, "c3", [
      msg("u", "user", "How do I deploy to Vercel?"),
      msg("a", "assistant", "Use the dashboard or the CLI to ship your project."),
    ]);
    await history.searchIndex.waitIndexing();

    // typo-tolerant match on the user side
    const userHits = await history.searchChats(user, "deploi vercel", { target: "user" });
    expect(userHits.some((h) => h.sessionId === "c3")).toBe(true);
    expect(userHits[0]?.score).toBeGreaterThan(0);

    // match on the model side
    const modelHits = await history.searchChats(user, "ship project", { target: "model" });
    expect(modelHits.some((h) => h.sessionId === "c3")).toBe(true);

    // scoped to the user — another user sees nothing
    expect(await history.searchChats("nobody", "vercel")).toHaveLength(0);
  });

  it("deletes a chat (and drops it from the index)", async () => {
    await history.saveChat(user, "gone", [msg("u", "user", "delete me")]);
    await history.deleteChat(user, "gone");
    expect(await history.getChat(user, "gone")).toBeNull();
    await history.searchIndex.waitIndexing();
    expect((await history.listChats(user)).find((c) => c.sessionId === "gone")).toBeUndefined();
  });

  it("recovers when the index is missing (reactive create + retry)", async () => {
    // Drop the index out from under us; the next read must recreate it and still return data.
    await history.searchIndex.drop().catch(() => {});
    const list = await history.listChats(user);
    expect(list.length).toBeGreaterThan(0);
  });
});
