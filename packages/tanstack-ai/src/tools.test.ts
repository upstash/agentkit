import { Sandbox, ToolCache } from "@upstash/agentkit-sdk";
import { MemoryRedis } from "@upstash/agentkit-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { wrapTool, wrapTools } from "./tools.js";
import type { TanStackTool } from "./types.js";

describe("wrapTools", () => {
  it("memoizes execution across identical calls via ToolCache", async () => {
    const toolCache = new ToolCache({ redis: new MemoryRedis() });
    const underlying = vi.fn(async (input: { q: string }) => `result:${input.q}`);
    const tool: TanStackTool<{ q: string }, string> = { name: "search", execute: underlying };

    const wrapped = wrapTool(tool, { toolCache });

    const a = await wrapped.execute({ q: "x" });
    const b = await wrapped.execute({ q: "x" });

    expect(a).toBe("result:x");
    expect(b).toBe("result:x");
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  it("re-runs for different arguments", async () => {
    const toolCache = new ToolCache({ redis: new MemoryRedis() });
    const underlying = vi.fn(async (input: { q: string }) => `result:${input.q}`);
    const wrapped = wrapTool({ name: "search", execute: underlying }, { toolCache });

    await wrapped.execute({ q: "x" });
    await wrapped.execute({ q: "y" });

    expect(underlying).toHaveBeenCalledTimes(2);
  });

  it("runs through the sandbox and caches when given both", async () => {
    const toolCache = new ToolCache({ redis: new MemoryRedis() });
    const sandbox = new Sandbox({ toolCache });
    const underlying = vi.fn(async (input: { q: string }) => `r:${input.q}`);
    const wrapped = wrapTool({ name: "fetch", execute: underlying }, { sandbox });

    expect(await wrapped.execute({ q: "1" })).toBe("r:1");
    expect(await wrapped.execute({ q: "1" })).toBe("r:1");
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  it("preserves name/description/parameters and handles a tool map", () => {
    const tools = {
      a: {
        name: "a",
        description: "tool a",
        parameters: { type: "object" },
        execute: async () => 1,
      },
      b: { name: "b", execute: async () => 2 },
    };
    const wrapped = wrapTools(tools);
    expect(Object.keys(wrapped)).toEqual(["a", "b"]);
    expect(wrapped.a?.description).toBe("tool a");
    expect(wrapped.a?.parameters).toEqual({ type: "object" });
  });

  it("passes through execution with no options", async () => {
    const underlying = vi.fn(async () => "raw");
    const [wrapped] = wrapTools([{ name: "t", execute: underlying }]);
    expect(await wrapped?.execute(undefined)).toBe("raw");
    expect(underlying).toHaveBeenCalledTimes(1);
  });
});
