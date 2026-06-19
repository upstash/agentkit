import { AgentMemory } from "@upstash/agentkit-sdk";
import { afterAll, describe, expect, it } from "vitest";
import { createMemoryTools } from "./memory.js";
import { hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

describe.skipIf(!hasRedisCreds)("createMemoryTools (live Redis)", () => {
  const memory = new AgentMemory({ redis: testRedis(), namespace: uniqueNamespace("aisdk-mem") });
  const tools = createMemoryTools({ memory, scope: "user-1" });

  afterAll(async () => {
    await memory.searchIndex.drop().catch(() => {});
  });

  it("exposes recall_memory and save_memory tools", () => {
    expect(Object.keys(tools).sort()).toEqual(["recall_memory", "save_memory"]);
    expect(tools.save_memory!.inputSchema).toBeDefined();
  });

  it("save_memory persists and recall_memory retrieves", async () => {
    const saved = (await tools.save_memory!.execute!(
      { text: "The user prefers dark mode" },
      {},
    )) as { id: string; saved: boolean };
    expect(saved.saved).toBe(true);
    await memory.searchIndex.waitIndexing();

    const recalled = (await tools.recall_memory!.execute!(
      { query: "ui theme preference" },
      {},
    )) as {
      text: string;
    }[];
    expect(recalled.some((m) => m.text.includes("dark mode"))).toBe(true);
  });
});
