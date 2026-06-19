import { AgentMemory } from "@upstash/agentkit-sdk";
import { afterAll, describe, expect, it } from "vitest";
import { recallMemoryTool, saveMemoryTool } from "./memory.js";
import { hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

describe.skipIf(!hasRedisCreds)("memory tools (live Redis)", () => {
  const memory = new AgentMemory({ redis: testRedis(), namespace: uniqueNamespace("eve-mem") });
  const recall = recallMemoryTool({ memory, scope: "user-1" });
  const save = saveMemoryTool({ memory, scope: "user-1" });

  afterAll(async () => {
    await memory.searchIndex.drop().catch(() => {});
  });

  it("produces defineTool configs with description + inputSchema", () => {
    expect(recall.description).toBeTypeOf("string");
    expect(recall.inputSchema).toBeDefined();
    expect(save.inputSchema).toBeDefined();
  });

  it("save then recall round-trips through AgentMemory", async () => {
    const saved = await save.execute({ text: "The user prefers dark mode" });
    expect(saved.saved).toBe(true);
    await memory.searchIndex.waitIndexing();

    const hits = await recall.execute({ query: "ui theme preference" });
    expect(hits.some((h) => h.text.includes("dark mode"))).toBe(true);
  });
});
