import { AgentMemory } from "@upstash/agentkit-sdk";
import { afterAll, describe, expect, it } from "vitest";
import { createMemoryTools } from "./memory.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

const TOOL_OPTS = { toolCallId: "t", messages: [] } as never;
function call<R>(execute: unknown, input: unknown): Promise<R> {
  return (execute as (i: unknown, o: unknown) => Promise<R>)(input, TOOL_OPTS);
}

describe.skipIf(!hasRedisCreds)("createMemoryTools (live Redis)", () => {
  const redis = testRedis();
  // The tools own their AgentMemory (default `agentkit:memory` index); isolate this run by scope.
  const ns = uniqueNamespace("aisdk-mem");
  const tools = createMemoryTools({ redis, namespace: ns });
  // A throwaway handle on the same default index, just to wait for indexing before recall.
  const index = new AgentMemory({ redis }).searchIndex;

  afterAll(async () => {
    await cleanupKeys(redis, `agentkit:memory:${ns}`);
  });

  it("exposes recall_memory and save_memory tools", () => {
    expect(Object.keys(tools).sort()).toEqual(["recall_memory", "save_memory"]);
    expect(tools.save_memory!.inputSchema).toBeDefined();
  });

  it("save_memory persists and recall_memory retrieves", async () => {
    const saved = await call<{ id: string; saved: boolean }>(tools.save_memory!.execute, {
      text: "The user prefers dark mode",
    });
    expect(saved.saved).toBe(true);
    await index.waitIndexing();

    const recalled = await call<{ text: string }[]>(tools.recall_memory!.execute, {
      query: "ui theme preference",
    });
    expect(recalled.some((m) => m.text.includes("dark mode"))).toBe(true);
  });
});
