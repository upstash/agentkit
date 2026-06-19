import { AgentMemory } from "@upstash/agentkit-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withMemory } from "./memory.js";
import { hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

describe.skipIf(!hasRedisCreds)("withMemory", () => {
  const redis = testRedis();
  const namespace = uniqueNamespace("memory");
  let memory: AgentMemory;

  beforeAll(async () => {
    memory = new AgentMemory({ redis, namespace });
    await memory.add("The user prefers dark mode", { scope: "prefs" });
    await memory.add("The user lives in Berlin", { scope: "prefs" });
    await memory.searchIndex.waitIndexing();
  });

  afterAll(async () => {
    await memory.searchIndex.drop().catch(() => {});
  });

  it("formats recalled memories as a system message", async () => {
    const injector = withMemory({ memory, scope: "prefs", topK: 5 });
    const sys = await injector.toSystemMessage("dark mode");
    expect(sys).not.toBeNull();
    expect(sys?.role).toBe("system");
    expect(String(sys?.content)).toContain("Relevant memories about the user:");
    expect(String(sys?.content)).toContain("dark mode");
  });

  it("prepends the system message via inject", async () => {
    const injector = withMemory({ memory, scope: "prefs" });
    const messages = await injector.inject("dark mode preference", [
      { role: "user", content: "hi" },
    ]);
    expect(messages[0]?.role).toBe("system");
    expect(messages[messages.length - 1]?.content).toBe("hi");
  });

  it("returns null / leaves messages untouched when nothing recalled", async () => {
    // A very high BM25 floor guarantees no hit for any query.
    const injector = withMemory({ memory, scope: "prefs", minScore: 1000 });
    expect(await injector.toSystemMessage("dark mode")).toBeNull();
    const original = [{ role: "user", content: "hi" }];
    expect(await injector.inject("dark mode", original)).toEqual(original);
  });

  it("uses a custom header", async () => {
    const injector = withMemory({ memory, scope: "prefs", header: "Known facts:" });
    const sys = await injector.toSystemMessage("Berlin");
    expect(String(sys?.content)).toContain("Known facts:");
  });
});
