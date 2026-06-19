import { describe, expect, it } from "vitest";
import {
  fromLangChainMessage,
  readMessageRole,
  toAgentKitRole,
  toLangChainMessage,
  toLangChainType,
} from "./messages.js";

describe("role conversion", () => {
  it("maps LangChain class types to AgentKit roles", () => {
    expect(toAgentKitRole("human")).toBe("user");
    expect(toAgentKitRole("ai")).toBe("assistant");
    expect(toAgentKitRole("system")).toBe("system");
    expect(toAgentKitRole("tool")).toBe("tool");
    expect(toAgentKitRole("function")).toBe("tool");
  });

  it("maps plain-object roles to AgentKit roles", () => {
    expect(toAgentKitRole("user")).toBe("user");
    expect(toAgentKitRole("assistant")).toBe("assistant");
  });

  it("falls back to user for unknown/undefined roles", () => {
    expect(toAgentKitRole("mystery")).toBe("user");
    expect(toAgentKitRole(undefined)).toBe("user");
  });

  it("maps AgentKit roles back to LangChain types", () => {
    expect(toLangChainType("user")).toBe("human");
    expect(toLangChainType("assistant")).toBe("ai");
    expect(toLangChainType("system")).toBe("system");
    expect(toLangChainType("tool")).toBe("tool");
  });
});

describe("readMessageRole", () => {
  it("prefers _getType() when present", () => {
    expect(readMessageRole({ content: "hi", _getType: () => "ai", role: "ignored" })).toBe("ai");
  });

  it("falls back to role for plain objects", () => {
    expect(readMessageRole({ content: "hi", role: "user" })).toBe("user");
  });
});

describe("message conversion round-trip", () => {
  it("converts a LangChain class-style message into a ChatMessage", () => {
    const msg = fromLangChainMessage({
      content: "answer",
      _getType: () => "ai",
      name: "bot",
      tool_call_id: "t1",
    });
    expect(msg).toEqual({
      role: "assistant",
      content: "answer",
      name: "bot",
      toolCallId: "t1",
    });
  });

  it("converts a plain { role, content } message", () => {
    expect(fromLangChainMessage({ role: "user", content: "hello" })).toEqual({
      role: "user",
      content: "hello",
    });
  });

  it("produces a LangChain message exposing both _getType() and role", () => {
    const lc = toLangChainMessage({ role: "assistant", content: "hi", name: "bot" });
    expect(lc.content).toBe("hi");
    expect(lc.role).toBe("ai");
    expect(lc._getType?.()).toBe("ai");
    expect(lc.name).toBe("bot");
  });

  it("round-trips a tool message", () => {
    const original = { role: "tool" as const, content: "result", toolCallId: "abc" };
    const back = fromLangChainMessage(toLangChainMessage(original));
    expect(back).toEqual(original);
  });
});
