import type { ChatMessage } from "@upstash/agentkit-sdk";
import { describe, expect, it } from "vitest";
import { fromEveMessages, toEveMessages } from "./messages.js";
import type { EveMessage } from "./types.js";

describe("message conversion", () => {
  it("converts AgentKit messages to Eve messages", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi", name: "alice" },
    ];
    const eve = toEveMessages(messages);
    expect(eve).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi", name: "alice" },
    ]);
  });

  it("converts Eve messages back, falling back unknown roles to user", () => {
    const eve: EveMessage[] = [
      { role: "assistant", content: "ok" },
      { role: "function", content: "data" },
    ];
    const back = fromEveMessages(eve);
    expect(back[0]!.role).toBe("assistant");
    expect(back[1]!.role).toBe("user");
  });

  it("coerces non-string content to a string", () => {
    const eve = [{ role: "user", content: 123 as unknown as string }];
    const back = fromEveMessages(eve);
    expect(back[0]!.content).toBe("123");
  });
});
