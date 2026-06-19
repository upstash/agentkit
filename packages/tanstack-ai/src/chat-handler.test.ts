import { ChatHistory } from "@upstash/agentkit-sdk";
import { MemoryRedis } from "@upstash/agentkit-sdk/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChatHandler } from "./chat-handler.js";
import type { TanStackMessage } from "./types.js";

describe("createChatHandler", () => {
  let history: ChatHistory;

  beforeEach(() => {
    history = new ChatHistory({ redis: new MemoryRedis() });
  });

  it("persists both the user and assistant messages", async () => {
    const generate = vi.fn(async () => "the answer");
    const handler = createChatHandler({ history, generate });

    const result = await handler({ sessionId: "s1", message: "the question" });

    expect(result.message.role).toBe("assistant");
    expect(result.message.content).toBe("the answer");

    const stored = await history.list("s1");
    expect(stored.map((m) => [m.role, m.content])).toEqual([
      ["user", "the question"],
      ["assistant", "the answer"],
    ]);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("passes prior history plus the new message to generate", async () => {
    await history.append("s1", { role: "user", content: "earlier" });
    let seen: TanStackMessage[] = [];
    const generate = vi.fn(async (messages: TanStackMessage[]) => {
      seen = messages;
      return "ok";
    });
    const handler = createChatHandler({ history, generate });

    await handler({ sessionId: "s1", message: "now" });

    expect(seen.map((m) => m.content)).toEqual(["earlier", "now"]);
  });

  it("accepts a full message object and returns the running conversation", async () => {
    const generate = vi.fn(async () => ({ role: "assistant" as const, content: "reply" }));
    const handler = createChatHandler({ history, generate });

    const result = await handler({
      sessionId: "s1",
      message: { role: "user", content: "hey", name: "alice" },
    });

    expect(result.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "hey"],
      ["assistant", "reply"],
    ]);
  });
});
