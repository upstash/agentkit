import { AgentMemory } from "@upstash/agentkit-sdk";
import { afterAll, describe, expect, it } from "vitest";
import { defineMemoryRecallTool, defineMemorySaveTool } from "./memory.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

const CTX = {} as never;

describe.skipIf(!hasRedisCreds)("memory tools (live Redis)", () => {
  const redis = testRedis();
  // The tools own their AgentMemory (default `agentkit:memory` index); isolate this run by namespace.
  const ns = uniqueNamespace("eve-mem");
  const recall = defineMemoryRecallTool({ redis, namespace: ns });
  const save = defineMemorySaveTool({ redis, namespace: ns });
  // A throwaway handle on the same default index, just to wait for indexing before recall.
  const index = new AgentMemory({ redis }).searchIndex;

  afterAll(async () => {
    await cleanupKeys(redis, `agentkit:memory:${ns}`);
  });

  it("produces tool configs with description + inputSchema", () => {
    expect(recall.description).toBeTypeOf("string");
    expect(save.inputSchema).toBeDefined();
  });

  it("save then recall round-trips through AgentMemory", async () => {
    const saved = await save.execute({ text: "The user prefers dark mode" }, CTX);
    expect(saved.saved).toBe(true);
    await index.waitIndexing();

    const hits = await recall.execute({ query: "ui theme preference" }, CTX);
    expect(hits.some((h) => h.text.includes("dark mode"))).toBe(true);
  });
});
