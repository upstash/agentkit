import { AgentMemory } from "@upstash/agentkit-sdk";
import { afterAll, describe, expect, it } from "vitest";
import { defineMemoryRecallTool, defineMemorySaveTool } from "./memory.js";
import { hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

const CTX = {} as never;

describe.skipIf(!hasRedisCreds)("memory tools (live Redis)", () => {
  const memory = new AgentMemory({ redis: testRedis(), namespace: uniqueNamespace("eve-mem") });
  const recall = defineMemoryRecallTool({ memory, namespace: "user-1" });
  const save = defineMemorySaveTool({ memory, namespace: "user-1" });

  afterAll(async () => {
    await memory.searchIndex.drop().catch(() => {});
  });

  it("produces tool configs with description + inputSchema", () => {
    expect(recall.description).toBeTypeOf("string");
    expect(save.inputSchema).toBeDefined();
  });

  it("save then recall round-trips through AgentMemory", async () => {
    const saved = await save.execute({ text: "The user prefers dark mode" }, CTX);
    expect(saved.saved).toBe(true);
    await memory.searchIndex.waitIndexing();

    const hits = await recall.execute({ query: "ui theme preference" }, CTX);
    expect(hits.some((h) => h.text.includes("dark mode"))).toBe(true);
  });
});
