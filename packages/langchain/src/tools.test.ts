import { Sandbox, ToolCache } from "@upstash/agentkit-sdk";
import { MemoryRedis } from "@upstash/agentkit-sdk/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cacheTool, sandboxTool } from "./tools.js";
import type { ToolLike } from "./types.js";

describe("cacheTool", () => {
  let redis: MemoryRedis;

  beforeEach(() => {
    redis = new MemoryRedis();
  });

  it("memoizes identical calls so the tool executes once", async () => {
    const cache = new ToolCache({ redis });
    const func = vi.fn(async (args: { n: number }) => args.n * 2);
    const tool: ToolLike<{ n: number }, number> = { name: "double", func };

    const cached = cacheTool(tool, cache);
    expect(await cached.invoke({ n: 21 })).toBe(42);
    expect(await cached.invoke({ n: 21 })).toBe(42);
    expect(func).toHaveBeenCalledTimes(1);
  });

  it("uses invoke() when present and preserves name/description", async () => {
    const cache = new ToolCache({ redis });
    const invoke = vi.fn(async (q: string) => `result:${q}`);
    const tool: ToolLike<string, string> = {
      name: "search",
      description: "searches things",
      invoke,
    };

    const cached = cacheTool(tool, cache);
    expect(cached.name).toBe("search");
    expect(cached.description).toBe("searches things");
    expect(await cached.invoke("upstash")).toBe("result:upstash");
    await cached.invoke("upstash");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("throws when the tool has no invoke/func", () => {
    const cache = new ToolCache({ redis });
    expect(() => cacheTool({ name: "broken" }, cache)).toThrow();
  });
});

describe("sandboxTool", () => {
  it("runs the tool through the sandbox and returns its value", async () => {
    const sandbox = new Sandbox();
    const tool: ToolLike<{ x: number }, number> = {
      name: "inc",
      func: async (args) => args.x + 1,
    };
    const safe = sandboxTool(tool, sandbox);
    expect(await safe.invoke({ x: 9 })).toBe(10);
  });

  it("retries a flaky tool and eventually succeeds", async () => {
    const sandbox = new Sandbox({ maxRetries: 2, retryDelayMs: 1 });
    let attempts = 0;
    const tool: ToolLike<void, string> = {
      name: "flaky",
      func: async () => {
        attempts += 1;
        if (attempts < 2) throw new Error("transient");
        return "ok";
      },
    };
    const safe = sandboxTool(tool, sandbox);
    expect(await safe.invoke(undefined)).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("caches through the sandbox when a ToolCache is attached", async () => {
    const redis = new MemoryRedis();
    const toolCache = new ToolCache({ redis });
    const sandbox = new Sandbox({ toolCache });
    const func = vi.fn(async (args: { city: string }) => ({ temp: 20, city: args.city }));
    const safe = sandboxTool({ name: "weather", func }, sandbox);

    await safe.invoke({ city: "NYC" });
    await safe.invoke({ city: "NYC" });
    expect(func).toHaveBeenCalledTimes(1);
  });
});
