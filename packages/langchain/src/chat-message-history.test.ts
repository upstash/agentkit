import { MemoryRedis } from "@upstash/agentkit-sdk/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { RedisChatMessageHistory } from "./chat-message-history.js";

describe("RedisChatMessageHistory", () => {
  let redis: MemoryRedis;

  beforeEach(() => {
    redis = new MemoryRedis();
  });

  it("round-trips user and AI messages", async () => {
    const history = new RedisChatMessageHistory({ redis, sessionId: "s1" });
    await history.addUserMessage("Hello");
    await history.addAIMessage("Hi there!");

    const messages = await history.getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toBe("Hello");
    expect(messages[0]!._getType?.()).toBe("human");
    expect(messages[1]!.content).toBe("Hi there!");
    expect(messages[1]!._getType?.()).toBe("ai");
  });

  it("addMessage accepts a LangChain-style class message and converts roles", async () => {
    const history = new RedisChatMessageHistory({ redis, sessionId: "s2" });
    await history.addMessage({ content: "system prompt", _getType: () => "system" });
    await history.addMessage({ content: "from tool", role: "tool", tool_call_id: "t9" });

    const messages = await history.getMessages();
    expect(messages[0]!._getType?.()).toBe("system");
    expect(messages[1]!._getType?.()).toBe("tool");
    expect(messages[1]!.tool_call_id).toBe("t9");
  });

  it("addMessages appends several at once preserving order", async () => {
    const history = new RedisChatMessageHistory({ redis, sessionId: "s3" });
    await history.addMessages([
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ]);
    const contents = (await history.getMessages()).map((m) => m.content);
    expect(contents).toEqual(["one", "two", "three"]);
  });

  it("clear() empties the session", async () => {
    const history = new RedisChatMessageHistory({ redis, sessionId: "s4" });
    await history.addUserMessage("keep?");
    await history.clear();
    expect(await history.getMessages()).toEqual([]);
  });

  it("isolates sessions from one another", async () => {
    const a = new RedisChatMessageHistory({ redis, sessionId: "a" });
    const b = new RedisChatMessageHistory({ redis, sessionId: "b" });
    await a.addUserMessage("for a");
    await b.addUserMessage("for b");
    expect((await a.getMessages()).map((m) => m.content)).toEqual(["for a"]);
    expect((await b.getMessages()).map((m) => m.content)).toEqual(["for b"]);
  });
});
