import { MemoryRedis, MemorySearchStore } from "@upstash/agentkit-sdk/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentKitMemory } from "./memory.js";

describe("AgentKitMemory", () => {
  let search: MemorySearchStore;
  let redis: MemoryRedis;

  beforeEach(() => {
    search = new MemorySearchStore();
    redis = new MemoryRedis();
  });

  it("remembers and recalls relevant memories", async () => {
    const memory = new AgentKitMemory({ search, redis, scope: "user-42" });
    await memory.remember("The user prefers metric units for measurement.");
    await memory.remember("The user lives in Berlin near the river.");

    const recalled = await memory.recall("which metric measurement units does the user prefer?", {
      topK: 1,
    });
    expect(recalled).toHaveLength(1);
    expect(recalled[0]!.text).toMatch(/metric units/);
  });

  it("formats recalled memories as a context string", async () => {
    const memory = new AgentKitMemory({ search, scope: "u", topK: 1 });
    await memory.remember("The user prefers metric units for measurement.");

    const context = await memory.asContext("what metric measurement units does the user prefer?");
    expect(context).toContain("Relevant memories:");
    expect(context).toContain("- The user prefers metric units for measurement.");
  });

  it("returns an empty context string when nothing is relevant", async () => {
    const memory = new AgentKitMemory({ search, minScore: 0.99 });
    const context = await memory.asContext("unrelated query about nothing stored");
    expect(context).toBe("");
  });

  it("isolates memories by scope", async () => {
    const memory = new AgentKitMemory({ search });
    await memory.remember("alpha fact about apples", { scope: "a" });
    await memory.remember("beta fact about bananas", { scope: "b" });

    const fromA = await memory.recall("alpha fact apples", { scope: "a", topK: 5 });
    expect(fromA.every((m) => m.text !== "beta fact about bananas")).toBe(true);
  });
});
