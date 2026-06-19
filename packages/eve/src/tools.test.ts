import { ToolCache } from "@upstash/agentkit-sdk";
import { afterAll, describe, expect, it, vi } from "vitest";
import { cacheTools } from "./tools.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";
import type { EveTool } from "./types.js";

describe.skipIf(!hasRedisCreds)("cacheTools (live Redis)", () => {
  const redis = testRedis();

  afterAll(async () => {
    await cleanupKeys(redis, "test:eve-tool");
  });

  it("caches results so execute runs once across two identical calls", async () => {
    const execute = vi.fn(async (args: unknown) => (args as { x: number }).x * 2);
    const toolCache = new ToolCache({ redis, namespace: uniqueNamespace("eve-tool") });
    const [wrapped] = cacheTools([{ name: "double", execute } as EveTool], { toolCache });

    expect(await wrapped!.execute({ x: 21 })).toBe(42);
    expect(await wrapped!.execute({ x: 21 })).toBe(42);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not share cache entries across different args", async () => {
    const execute = vi.fn(async (args: unknown) => (args as { x: number }).x + 1);
    const toolCache = new ToolCache({ redis, namespace: uniqueNamespace("eve-tool") });
    const [wrapped] = cacheTools([{ name: "inc", execute } as EveTool], { toolCache });

    await wrapped!.execute({ x: 1 });
    await wrapped!.execute({ x: 2 });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("runs without a cache (passthrough)", async () => {
    const execute = vi.fn(async () => "ok");
    const [wrapped] = cacheTools([{ name: "t", execute } as EveTool]);
    expect(await wrapped!.execute({})).toBe("ok");
    expect(await wrapped!.execute({})).toBe("ok");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("preserves name/description/parameters on wrapped tools", () => {
    const [wrapped] = cacheTools([
      {
        name: "search",
        description: "search the web",
        parameters: { type: "object" },
        execute: async () => "x",
      } as EveTool,
    ]);
    expect(wrapped!.name).toBe("search");
    expect(wrapped!.description).toBe("search the web");
    expect(wrapped!.parameters).toEqual({ type: "object" });
  });
});
