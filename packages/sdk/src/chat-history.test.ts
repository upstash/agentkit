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
  const history = new ChatHistory<Msg>({ redis, prefix: uniqueNamespace("chat") });
  const user = "user-1";

  afterAll(async () => {
    await history.searchIndex.drop().catch(() => {});
  });

  it("saves the full transcript and fetches it back by id", async () => {
    await history.saveChat({
      userId: user,
      sessionId: "c1",
      messages: [msg("m1", "user", "hi"), msg("m2", "assistant", "hello")],
      title: "First chat",
    });
    const got = await history.getChat({ userId: user, sessionId: "c1" });
    expect(got?.title).toBe("First chat");
    expect(got?.messages).toHaveLength(2);
    expect(got?.messageCount).toBe(2);

    // Overwrite with the whole conversation again (no delta merge).
    await history.saveChat({
      userId: user,
      sessionId: "c1",
      messages: [
        msg("m1", "user", "hi"),
        msg("m2", "assistant", "hello"),
        msg("m3", "user", "bye"),
      ],
    });
    expect((await history.getChat({ userId: user, sessionId: "c1" }))?.messages).toHaveLength(3);
    // Title is preserved across overwrites.
    expect((await history.getChat({ userId: user, sessionId: "c1" }))?.title).toBe("First chat");
  });

  it("isolates chats by user", async () => {
    expect(await history.getChat({ userId: "someone-else", sessionId: "c1" })).toBeNull();
  });

  // Chats are keyed per user (`<namespace>:<userId>:<sessionId>`), so a second user reusing the same
  // sessionId gets their OWN separate chat and can't read or clobber another user's.
  it("scopes chats per user — same sessionId, different user, is a separate chat", async () => {
    await history.saveChat({
      userId: "other-user",
      sessionId: "c1", // same sessionId as user-1's chat above
      messages: [msg("x", "user", "this is mine")],
    });

    // user-1's transcript is untouched...
    const mine = await history.getChat({ userId: user, sessionId: "c1" });
    expect(mine?.messages).toHaveLength(3);
    expect(mine?.userId).toBe(user);

    // ...and the other user sees only their own one-message chat.
    const theirs = await history.getChat({ userId: "other-user", sessionId: "c1" });
    expect(theirs?.messages).toHaveLength(1);
    expect(theirs?.userId).toBe("other-user");

    await history.deleteChat({ userId: "other-user", sessionId: "c1" }); // cleanup
  });

  // userId / sessionId are the tenant boundary — an empty/missing one must throw, never silently
  // mis-scope (these are validated before any Redis call, so they work without an index).
  it("throws on empty or missing userId / sessionId", async () => {
    await expect(history.saveChat({ userId: "", sessionId: "x", messages: [] })).rejects.toThrow(
      /userId/,
    );
    await expect(history.saveChat({ userId: user, sessionId: "", messages: [] })).rejects.toThrow(
      /sessionId/,
    );
    await expect(
      history.getChat({ userId: undefined as unknown as string, sessionId: "x" }),
    ).rejects.toThrow(/userId/);
    await expect(history.deleteChat({ userId: user, sessionId: "" })).rejects.toThrow(/sessionId/);
    await expect(history.listChats({ userId: "" })).rejects.toThrow(/userId/);
    await expect(history.searchChats({ userId: "", query: "hi" })).rejects.toThrow(/userId/);
  });

  it("lists a user's chats (filtered by userId in the index)", async () => {
    await history.saveChat({
      userId: user,
      sessionId: "c2",
      messages: [msg("a", "user", "second chat")],
      title: "Second",
    });
    await history.searchIndex.waitIndexing();

    const list = await history.listChats({ userId: user });
    const ids = list.map((c) => c.sessionId);
    expect(ids).toContain("c1");
    expect(ids).toContain("c2");
    expect(list[0]).not.toHaveProperty("messages");

    expect(await history.listChats({ userId: "nobody" })).toHaveLength(0);
  });

  it("fuzzily searches user/model messages", async () => {
    await history.saveChat({
      userId: user,
      sessionId: "c3",
      messages: [
        msg("u", "user", "How do I deploy to Vercel?"),
        msg("a", "assistant", "Use the dashboard or the CLI to ship your project."),
      ],
    });
    await history.searchIndex.waitIndexing();

    // typo-tolerant match on the user side
    const userHits = await history.searchChats({
      userId: user,
      query: "deploi vercel",
      target: "user",
    });
    expect(userHits.some((h) => h.sessionId === "c3")).toBe(true);
    expect(userHits[0]?.score).toBeGreaterThan(0);

    // match on the model side
    const modelHits = await history.searchChats({
      userId: user,
      query: "ship project",
      target: "model",
    });
    expect(modelHits.some((h) => h.sessionId === "c3")).toBe(true);

    // scoped to the user — another user sees nothing
    expect(await history.searchChats({ userId: "nobody", query: "vercel" })).toHaveLength(0);
  });

  it("deletes a chat (and drops it from the index)", async () => {
    await history.saveChat({
      userId: user,
      sessionId: "gone",
      messages: [msg("u", "user", "delete me")],
    });
    await history.deleteChat({ userId: user, sessionId: "gone" });
    expect(await history.getChat({ userId: user, sessionId: "gone" })).toBeNull();
    await history.searchIndex.waitIndexing();
    expect(
      (await history.listChats({ userId: user })).find((c) => c.sessionId === "gone"),
    ).toBeUndefined();
  });

  it("recovers when the index is missing (reactive create + retry)", async () => {
    // Drop the index out from under us; the next read must recreate it and still return data.
    await history.searchIndex.drop().catch(() => {});
    const list = await history.listChats({ userId: user });
    expect(list.length).toBeGreaterThan(0);
  });
});
