import { AgentMemory } from "@upstash/agentkit-sdk";
import { MemoryVectorStore, MockEmbedder } from "@upstash/agentkit-sdk/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { withMemory } from "./memory.js";

describe("withMemory", () => {
  let memory: AgentMemory;

  beforeEach(async () => {
    const embedder = new MockEmbedder();
    const vector = new MemoryVectorStore({ embed: embedder.embedOne });
    memory = new AgentMemory({ vector, embedder });
    await memory.add("The user prefers dark mode", { scope: "u1" });
    await memory.add("The user lives in Berlin", { scope: "u1" });
  });

  it("formats recalled memories as a system message", async () => {
    const injector = withMemory({ memory, scope: "u1", topK: 5 });
    const sys = await injector.toSystemMessage("what theme does the user like");
    expect(sys).not.toBeNull();
    expect(sys?.role).toBe("system");
    expect(String(sys?.content)).toContain("Relevant memories about the user:");
    expect(String(sys?.content)).toContain("dark mode");
  });

  it("prepends the system message via inject", async () => {
    const injector = withMemory({ memory, scope: "u1" });
    const messages = await injector.inject("dark mode preference", [
      { role: "user", content: "hi" },
    ]);
    expect(messages[0]?.role).toBe("system");
    expect(messages[messages.length - 1]?.content).toBe("hi");
  });

  it("returns null / leaves messages untouched when nothing recalled", async () => {
    const injector = withMemory({ memory, scope: "u1", minScore: 1.1 });
    expect(await injector.toSystemMessage("anything")).toBeNull();
    const original = [{ role: "user", content: "hi" }];
    expect(await injector.inject("anything", original)).toEqual(original);
  });

  it("uses a custom header", async () => {
    const injector = withMemory({ memory, scope: "u1", header: "Known facts:" });
    const sys = await injector.toSystemMessage("Berlin");
    expect(String(sys?.content)).toContain("Known facts:");
  });
});
