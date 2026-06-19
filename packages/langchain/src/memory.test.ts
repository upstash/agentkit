import { describe, expect, it } from "vitest";
import { AgentKitMemory } from "./memory.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

describe.skipIf(!hasRedisCreds)("AgentKitMemory (live Redis)", () => {
  const redis = testRedis();

  it("remembers and recalls relevant memories", async () => {
    const namespace = uniqueNamespace("memory-recall");
    const memory = new AgentKitMemory({ redis, namespace, scope: "user-42" });
    try {
      await memory.remember("The user prefers metric units for measurement.");
      await memory.remember("The user lives in Berlin near the river.");
      await memory.searchIndex.waitIndexing();

      const recalled = await memory.recall("which metric measurement units does the user prefer?", {
        topK: 1,
      });
      expect(recalled).toHaveLength(1);
      expect(recalled[0]!.text).toMatch(/metric units/);
    } finally {
      await memory.searchIndex.drop().catch(() => {});
      await cleanupKeys(redis, namespace);
    }
  });

  it("formats recalled memories as a context string", async () => {
    const namespace = uniqueNamespace("memory-context");
    const memory = new AgentKitMemory({ redis, namespace, scope: "u", topK: 1 });
    try {
      await memory.remember("The user prefers metric units for measurement.");
      await memory.searchIndex.waitIndexing();

      const context = await memory.asContext("what metric measurement units does the user prefer?");
      expect(context).toContain("Relevant memories:");
      expect(context).toContain("- The user prefers metric units for measurement.");
    } finally {
      await memory.searchIndex.drop().catch(() => {});
      await cleanupKeys(redis, namespace);
    }
  });

  it("returns an empty context string when nothing is relevant", async () => {
    const namespace = uniqueNamespace("memory-noctx");
    const memory = new AgentKitMemory({ redis, namespace, minScore: 1e9 });
    try {
      await memory.remember("some stored but irrelevant fact");
      await memory.searchIndex.waitIndexing();

      const context = await memory.asContext("unrelated query about nothing stored");
      expect(context).toBe("");
    } finally {
      await memory.searchIndex.drop().catch(() => {});
      await cleanupKeys(redis, namespace);
    }
  });

  it("isolates memories by scope", async () => {
    const namespace = uniqueNamespace("memory-scope");
    const memory = new AgentKitMemory({ redis, namespace });
    try {
      await memory.remember("alpha fact about apples", { scope: "a" });
      await memory.remember("beta fact about bananas", { scope: "b" });
      await memory.searchIndex.waitIndexing();

      const fromA = await memory.recall("alpha fact apples", { scope: "a", topK: 5 });
      expect(fromA.length).toBeGreaterThan(0);
      expect(fromA.every((m) => m.text !== "beta fact about bananas")).toBe(true);
    } finally {
      await memory.searchIndex.drop().catch(() => {});
      await cleanupKeys(redis, namespace);
    }
  });
});
