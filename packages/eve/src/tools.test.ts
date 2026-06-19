import { Sandbox, ToolCache } from "@upstash/agentkit-sdk";
import { MemoryRedis } from "@upstash/agentkit-sdk/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sandboxTools } from "./tools.js";
import type { EveTool } from "./types.js";

describe("sandboxTools", () => {
  let redis: MemoryRedis;

  beforeEach(() => {
    redis = new MemoryRedis();
  });

  it("caches results so execute runs once across two identical calls", async () => {
    const execute = vi.fn(async (args: unknown) => (args as { x: number }).x * 2);
    const tool: EveTool = { name: "double", execute };
    const toolCache = new ToolCache({ redis });

    const [wrapped] = sandboxTools([tool], { toolCache });
    expect(wrapped).toBeDefined();

    const first = await wrapped!.execute({ x: 21 });
    const second = await wrapped!.execute({ x: 21 });

    expect(first).toBe(42);
    expect(second).toBe(42);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not share cache entries across different args", async () => {
    const execute = vi.fn(async (args: unknown) => (args as { x: number }).x + 1);
    const toolCache = new ToolCache({ redis });
    const [wrapped] = sandboxTools([{ name: "inc", execute }], { toolCache });

    await wrapped!.execute({ x: 1 });
    await wrapped!.execute({ x: 2 });

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("surfaces a thrown tool as a structured rejection after retries", async () => {
    const execute = vi.fn(async () => {
      throw new Error("boom");
    });
    const sandbox = new Sandbox({ maxRetries: 2, retryDelayMs: 1 });
    const [wrapped] = sandboxTools([{ name: "explode", execute }], { sandbox });

    await expect(wrapped!.execute({})).rejects.toThrow("boom");
    // 1 initial attempt + 2 retries.
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("retries then succeeds, caching the eventual result", async () => {
    let calls = 0;
    const execute = vi.fn(async () => {
      calls += 1;
      if (calls < 2) throw new Error("transient");
      return "ok";
    });
    const toolCache = new ToolCache({ redis });
    const sandbox = new Sandbox({ maxRetries: 3, retryDelayMs: 1, toolCache });
    const [wrapped] = sandboxTools([{ name: "flaky", execute }], { sandbox });

    expect(await wrapped!.execute({ q: 1 })).toBe("ok");
    expect(calls).toBe(2);

    // Second identical call is served from cache; execute is not invoked again.
    expect(await wrapped!.execute({ q: 1 })).toBe("ok");
    expect(calls).toBe(2);
  });

  it("preserves name/description/parameters on wrapped tools", () => {
    const tool: EveTool = {
      name: "search",
      description: "search the web",
      parameters: { type: "object" },
      execute: async () => "x",
    };
    const [wrapped] = sandboxTools([tool]);
    expect(wrapped!.name).toBe("search");
    expect(wrapped!.description).toBe("search the web");
    expect(wrapped!.parameters).toEqual({ type: "object" });
  });

  it("forwards an abort signal from the Eve tool context", async () => {
    const seen: (boolean | undefined)[] = [];
    const tool: EveTool = {
      name: "needs-signal",
      execute: async (_args, ctx) => {
        seen.push(ctx?.signal !== undefined);
        return "done";
      },
    };
    const [wrapped] = sandboxTools([tool]);
    const controller = new AbortController();
    await wrapped!.execute({}, { signal: controller.signal });
    expect(seen).toEqual([true]);
  });
});
