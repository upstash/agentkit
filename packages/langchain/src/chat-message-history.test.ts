import { describe, expect, it } from "vitest";
import { RedisChatMessageHistory } from "./chat-message-history.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

describe.skipIf(!hasRedisCreds)("RedisChatMessageHistory (live Redis)", () => {
  const redis = testRedis();

  it("round-trips user and AI messages", async () => {
    const namespace = uniqueNamespace("chat-roundtrip");
    const history = new RedisChatMessageHistory({ redis, namespace, sessionId: "s1" });
    try {
      await history.addUserMessage("Hello");
      await history.addAIMessage("Hi there!");

      const messages = await history.getMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0]!.content).toBe("Hello");
      expect(messages[0]!._getType?.()).toBe("human");
      expect(messages[1]!.content).toBe("Hi there!");
      expect(messages[1]!._getType?.()).toBe("ai");
    } finally {
      await cleanupKeys(redis, namespace);
    }
  });

  it("addMessage accepts a LangChain-style class message and converts roles", async () => {
    const namespace = uniqueNamespace("chat-classmsg");
    const history = new RedisChatMessageHistory({ redis, namespace, sessionId: "s2" });
    try {
      await history.addMessage({ content: "system prompt", _getType: () => "system" });
      await history.addMessage({ content: "from tool", role: "tool", tool_call_id: "t9" });

      const messages = await history.getMessages();
      expect(messages[0]!._getType?.()).toBe("system");
      expect(messages[1]!._getType?.()).toBe("tool");
      expect(messages[1]!.tool_call_id).toBe("t9");
    } finally {
      await cleanupKeys(redis, namespace);
    }
  });

  it("addMessages appends several at once preserving order", async () => {
    const namespace = uniqueNamespace("chat-multi");
    const history = new RedisChatMessageHistory({ redis, namespace, sessionId: "s3" });
    try {
      await history.addMessages([
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
      ]);
      const contents = (await history.getMessages()).map((m) => m.content);
      expect(contents).toEqual(["one", "two", "three"]);
    } finally {
      await cleanupKeys(redis, namespace);
    }
  });

  it("clear() empties the session", async () => {
    const namespace = uniqueNamespace("chat-clear");
    const history = new RedisChatMessageHistory({ redis, namespace, sessionId: "s4" });
    try {
      await history.addUserMessage("keep?");
      await history.clear();
      expect(await history.getMessages()).toEqual([]);
    } finally {
      await cleanupKeys(redis, namespace);
    }
  });

  it("isolates sessions from one another", async () => {
    const namespace = uniqueNamespace("chat-isolate");
    const a = new RedisChatMessageHistory({ redis, namespace, sessionId: "a" });
    const b = new RedisChatMessageHistory({ redis, namespace, sessionId: "b" });
    try {
      await a.addUserMessage("for a");
      await b.addUserMessage("for b");
      expect((await a.getMessages()).map((m) => m.content)).toEqual(["for a"]);
      expect((await b.getMessages()).map((m) => m.content)).toEqual(["for b"]);
    } finally {
      await cleanupKeys(redis, namespace);
    }
  });
});
