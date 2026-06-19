import { ChatHistory } from "@upstash/agentkit-sdk";
import { MemoryRedis } from "@upstash/agentkit-sdk/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { createChatHistoryAdapter } from "./history-adapter.js";

describe("createChatHistoryAdapter", () => {
  let history: ChatHistory;

  beforeEach(() => {
    history = new ChatHistory({ redis: new MemoryRedis() });
  });

  it("persists and loads messages for a session", async () => {
    const adapter = createChatHistoryAdapter({ history });
    await adapter.addMessage("s1", { role: "user", content: "hi" });
    await adapter.addMessage("s1", { role: "assistant", content: "hello" });

    const messages = await adapter.getMessages("s1");
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "hi"],
      ["assistant", "hello"],
    ]);
  });

  it("isolates sessions", async () => {
    const adapter = createChatHistoryAdapter({ history });
    await adapter.addMessage("a", { role: "user", content: "for a" });
    await adapter.addMessage("b", { role: "user", content: "for b" });
    expect((await adapter.getMessages("a")).map((m) => m.content)).toEqual(["for a"]);
    expect((await adapter.getMessages("b")).map((m) => m.content)).toEqual(["for b"]);
  });

  it("adds many messages and respects the load limit", async () => {
    const adapter = createChatHistoryAdapter({ history, limit: 2 });
    await adapter.addMessages("s", [
      { role: "user", content: "1" },
      { role: "assistant", content: "2" },
      { role: "user", content: "3" },
    ]);
    const messages = await adapter.getMessages("s");
    expect(messages.map((m) => m.content)).toEqual(["2", "3"]);
  });

  it("clears a session", async () => {
    const adapter = createChatHistoryAdapter({ history });
    await adapter.addMessage("s", { role: "user", content: "x" });
    await adapter.clear("s");
    expect(await adapter.getMessages("s")).toEqual([]);
  });
});
