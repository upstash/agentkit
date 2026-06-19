import { AgentMemory } from "@upstash/agentkit-sdk";
import { afterAll, describe, expect, it, vi } from "vitest";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";
import type { EveAgentConfig, EveTool } from "./types.js";
import { withAgentKit } from "./with-agentkit.js";

describe.skipIf(!hasRedisCreds)("withAgentKit (live Redis)", () => {
  const redis = testRedis();

  afterAll(async () => {
    await cleanupKeys(redis, "agentkit:tool");
    await cleanupKeys(redis, "agentkit:telemetry");
    await cleanupKeys(redis, "test:eve-wak");
  });

  it("wraps tools so a second identical call hits the cache", async () => {
    // Unique tool name avoids cross-run collisions in the default tool-cache namespace.
    const name = `times-ten-${uniqueNamespace("x").slice(-8)}`;
    const execute = vi.fn(async (args: unknown) => (args as { x: number }).x * 10);
    const base: EveAgentConfig = {
      instructions: "be helpful",
      tools: [{ name, execute } as EveTool],
    };

    const { agent } = await withAgentKit(base, { redis });
    const wrapped = agent.tools?.[0];
    expect(wrapped).not.toBe(base.tools![0]);

    expect(await wrapped!.execute({ x: 5 })).toBe(50);
    expect(await wrapped!.execute({ x: 5 })).toBe(50);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not mutate the original agent config", async () => {
    const tool: EveTool = { name: `t-${uniqueNamespace("x").slice(-8)}`, execute: async () => 1 };
    const base: EveAgentConfig = { instructions: "x", tools: [tool] };
    const { agent } = await withAgentKit(base, { redis });
    expect(base.tools![0]).toBe(tool);
    expect(agent.tools![0]).not.toBe(tool);
    expect(agent).not.toBe(base);
  });

  it("augments instructions with recalled memories", async () => {
    const memory = new AgentMemory({ redis, namespace: uniqueNamespace("eve-wak-mem") });
    await memory.add("The user prefers concise answers", { scope: "user-9" });
    await memory.searchIndex.waitIndexing();

    try {
      const { agent } = await withAgentKit(
        { instructions: "You are helpful." },
        { redis, memory, scope: "user-9", useMemory: true, context: "concise answers preference" },
      );
      expect(agent.instructions).toContain("You are helpful.");
      expect(agent.instructions).toContain("The user prefers concise answers");
    } finally {
      await memory.searchIndex.drop().catch(() => {});
    }
  });

  it("exposes history hooks that round-trip when redis + sessionId are given", async () => {
    const sessionId = uniqueNamespace("eve-wak-sess");
    const { history } = await withAgentKit({}, { redis, sessionId });
    expect(history).toBeDefined();
    await history!.append({ role: "user", content: "hi" });
    const loaded = await history!.load();
    expect(loaded[0]).toMatchObject({ role: "user", content: "hi" });
  });

  it("trace runs the function and returns its value (telemetry present)", async () => {
    const { trace } = await withAgentKit({}, { redis });
    expect(await trace("run", async () => "done")).toBe("done");
  });

  it("trace is a passthrough when no redis is configured", async () => {
    const { trace, telemetry, history } = await withAgentKit({}, {});
    expect(telemetry).toBeUndefined();
    expect(history).toBeUndefined();
    expect(await trace("run", async () => 7)).toBe(7);
  });
});
