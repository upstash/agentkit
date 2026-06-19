import type { ChatMessage } from "@upstash/agentkit-sdk";
import { describe, expect, it } from "vitest";
import { fromCoreMessages, toCoreMessages } from "./messages.js";
import type { CoreMessageLike } from "./types.js";

describe("message conversion", () => {
  it("round-trips AgentKit messages through core messages", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "tool", content: "result", name: "search" },
    ];
    const core = toCoreMessages(messages);
    const back = fromCoreMessages(core);
    expect(back).toEqual(messages);
  });

  it("maps roles 1:1 to core messages", () => {
    const core = toCoreMessages([{ role: "user", content: "hi" }]);
    expect(core[0]).toEqual({ role: "user", content: "hi" });
  });

  it("flattens array (parts) content into a string", () => {
    const core: CoreMessageLike[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
          { type: "tool-call", text: undefined },
        ],
      },
    ];
    const back = fromCoreMessages(core);
    expect(back[0]?.content).toBe("Hello world");
  });

  it("falls back unknown roles to user", () => {
    const back = fromCoreMessages([{ role: "function", content: "x" }]);
    expect(back[0]?.role).toBe("user");
  });
});
