import { AgentMemory } from "@upstash/agentkit-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemoryTools } from "./memory.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueUserId } from "./test-support.js";

/** Poll a read until it reflects a just-written doc — insurance for residual indexing lag. */
async function pollUntil<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8_000; // well inside vitest's 30s testTimeout
  let value = await read();
  while (!ready(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    value = await read();
  }
  return value;
}

const TOOL_OPTS = { toolCallId: "t", messages: [] } as never;
function call<R>(execute: unknown, input: unknown): Promise<R> {
  return (execute as (i: unknown, o: unknown) => Promise<R>)(input, TOOL_OPTS);
}

describe.skipIf(!hasRedisCreds)("createMemoryTools (live Redis)", () => {
  const redis = testRedis();
  // The tools own their AgentMemory (default `agentkit:memory` index); isolate this run by scope.
  const ns = uniqueUserId("aisdk-mem");
  const tools = createMemoryTools({ redis, userId: ns });
  // A throwaway handle on the same default index, just to wait for indexing before recall.
  const index = new AgentMemory({ redis }).searchIndex;

  // Make sure the index exists before anything is written into its keyspace: `waitIndexing()` on a
  // missing index is a silent no-op, so a save followed by a recall would otherwise race the
  // reactive create. A recall on a missing index returns the `null` sentinel and provisions it.
  beforeAll(async () => {
    await call(tools.recall_memory!.execute, { query: "provisioning probe" });
  });

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

    const recalled = await pollUntil(
      () =>
        call<{ text: string }[]>(tools.recall_memory!.execute, { query: "ui theme preference" }),
      (found) => found.some((m) => m.text.includes("dark mode")),
    );
    expect(recalled.some((m) => m.text.includes("dark mode"))).toBe(true);
  });
});
