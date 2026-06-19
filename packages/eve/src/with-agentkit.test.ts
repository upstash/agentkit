import { AgentMemory } from "@upstash/agentkit-sdk";
import { MemoryRedis, MemorySearchStore } from "@upstash/agentkit-sdk/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EveAgentConfig, EveTool } from "./types.js";
import { withAgentKit } from "./with-agentkit.js";

describe("withAgentKit", () => {
  let redis: MemoryRedis;
  let search: MemorySearchStore;

  beforeEach(() => {
    redis = new MemoryRedis();
    search = new MemorySearchStore();
  });

  it("wraps tools so a second identical call hits the cache", async () => {
    const execute = vi.fn(async (args: unknown) => (args as { x: number }).x * 10);
    const tool: EveTool = { name: "times-ten", execute };
    const base: EveAgentConfig = { instructions: "be helpful", tools: [tool] };

    const { agent } = await withAgentKit(base, { redis });
    const wrapped = agent.tools?.[0];
    expect(wrapped).toBeDefined();
    expect(wrapped).not.toBe(tool);

    const a = await wrapped!.execute({ x: 5 });
    const b = await wrapped!.execute({ x: 5 });
    expect(a).toBe(50);
    expect(b).toBe(50);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not mutate the original agent config", async () => {
    const tool: EveTool = { name: "t", execute: async () => 1 };
    const base: EveAgentConfig = { instructions: "x", tools: [tool] };
    const { agent } = await withAgentKit(base, { redis });
    expect(base.tools![0]).toBe(tool);
    expect(agent.tools![0]).not.toBe(tool);
    expect(agent).not.toBe(base);
  });

  it("augments instructions with recalled memories", async () => {
    const memory = new AgentMemory({ search });
    await memory.add("The user prefers concise answers", { scope: "user-9" });

    const { agent } = await withAgentKit(
      { instructions: "You are helpful." },
      {
        search,
        memory,
        scope: "user-9",
        useMemory: true,
        context: "the user prefers concise answers",
      },
    );

    expect(agent.instructions).toContain("You are helpful.");
    expect(agent.instructions).toContain("Relevant memories:");
    expect(agent.instructions).toContain("The user prefers concise answers");
  });

  it("exposes history hooks that round-trip when redis + sessionId are given", async () => {
    const { history } = await withAgentKit({}, { redis, sessionId: "sess-1" });
    expect(history).toBeDefined();
    await history!.append({ role: "user", content: "hi" });
    const loaded = await history!.load();
    expect(loaded[0]).toMatchObject({ role: "user", content: "hi" });
  });

  it("trace runs the function and returns its value (telemetry present)", async () => {
    const { trace } = await withAgentKit({}, { redis });
    const result = await trace("run", async () => "done");
    expect(result).toBe("done");
  });

  it("trace is a passthrough when no redis is configured", async () => {
    const { trace, telemetry, history } = await withAgentKit({}, {});
    expect(telemetry).toBeUndefined();
    expect(history).toBeUndefined();
    expect(await trace("run", async () => 7)).toBe(7);
  });
});
