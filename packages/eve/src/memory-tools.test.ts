import { AgentMemory } from "@upstash/agentkit-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineMemoryRecallTool, defineMemorySaveTool } from "./memory-tools.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueUserId } from "./test-support.js";

const CTX = {} as never;

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

describe.skipIf(!hasRedisCreds)("memory tools (live Redis)", () => {
  const redis = testRedis();
  // The tools own their AgentMemory (default `agentkit:memory` index); isolate this run by userId.
  const ns = uniqueUserId("eve-mem");
  const recall = defineMemoryRecallTool({ redis, userId: ns });
  const save = defineMemorySaveTool({ redis, userId: ns });
  // A throwaway handle on the same default index, just to wait for indexing before recall.
  const index = new AgentMemory({ redis }).searchIndex;

  // Provision before the first write: `waitIndexing()` on an index that does not exist yet is a
  // silent no-op, so a save followed by a recall would race the reactive create. A recall on a
  // missing index returns the `null` sentinel, which creates it and retries.
  beforeAll(async () => {
    await recall.execute({ query: "provisioning probe" }, CTX);
  });

  afterAll(async () => {
    await cleanupKeys(redis, `agentkit:memory:${ns}`);
  });

  it("produces tool configs with description + inputSchema", () => {
    expect(recall.description).toBeTypeOf("string");
    expect(save.inputSchema).toBeDefined();
  });

  it("save then recall round-trips through AgentMemory", async () => {
    // eve ≥0.31 types `execute` as possibly returning an AsyncIterable of output snapshots;
    // our executors always resolve, so narrow the awaited results back to their plain values.
    const saved = (await save.execute({ text: "The user prefers dark mode" }, CTX)) as {
      id: string;
      saved: boolean;
    };
    expect(saved.saved).toBe(true);
    await index.waitIndexing();

    const hits = await pollUntil(
      async () =>
        (await recall.execute({ query: "ui theme preference" }, CTX)) as {
          text: string;
          score: number;
        }[],
      (found) => found.some((h) => h.text.includes("dark mode")),
    );
    expect(hits.some((h) => h.text.includes("dark mode"))).toBe(true);
  });
});
