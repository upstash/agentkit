import type { ChatMessage } from "@upstash/agentkit-sdk";
import { describe, expect, it } from "vitest";
import {
  fromTanStackMessage,
  fromTanStackMessages,
  toTanStackMessage,
  toTanStackMessages,
} from "./messages.js";
import type { TanStackMessage } from "./types.js";

describe("message conversion", () => {
  it("maps AgentKit messages to TanStack messages", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "be nice" },
      { role: "user", content: "hi", createdAt: 1 },
      { role: "tool", content: "{}", name: "search", toolCallId: "c1" },
    ];
    const out = toTanStackMessages(messages);
    expect(out).toEqual([
      { role: "system", content: "be nice" },
      { role: "user", content: "hi", createdAt: 1 },
      { role: "tool", content: "{}", name: "search", toolCallId: "c1" },
    ]);
  });

  it("surfaces an id stashed in metadata", () => {
    const msg: ChatMessage = { role: "user", content: "hi", metadata: { id: "m1", extra: 2 } };
    const out = toTanStackMessage(msg);
    expect(out.id).toBe("m1");
    expect(out.metadata).toEqual({ extra: 2 });
  });

  it("preserves a TanStack id inside metadata on the way in", () => {
    const msg: TanStackMessage = { id: "abc", role: "assistant", content: "yo" };
    const out = fromTanStackMessage(msg);
    expect(out.metadata).toEqual({ id: "abc" });
  });

  it("round-trips losslessly", () => {
    const original: TanStackMessage[] = [
      { id: "1", role: "user", content: "question", createdAt: 10 },
      { id: "2", role: "assistant", content: "answer", name: "bot", metadata: { tag: "x" } },
    ];
    const roundTripped = toTanStackMessages(fromTanStackMessages(original));
    expect(roundTripped).toEqual([
      { id: "1", role: "user", content: "question", createdAt: 10 },
      { id: "2", role: "assistant", content: "answer", name: "bot", metadata: { tag: "x" } },
    ]);
  });

  it("falls back unknown roles to user", () => {
    const out = fromTanStackMessage({ role: "weird" as TanStackMessage["role"], content: "x" });
    expect(out.role).toBe("user");
  });
});
