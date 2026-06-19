import { ToolCache } from "@upstash/agentkit-sdk";
import { describe, expect, it, vi } from "vitest";
import { cacheTool } from "./tools.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";
import type { ToolLike } from "./types.js";

describe.skipIf(!hasRedisCreds)("cacheTool (live Redis)", () => {
  const redis = testRedis();

  it("memoizes identical calls so the tool executes once", async () => {
    const namespace = uniqueNamespace("tool-memoize");
    const cache = new ToolCache({ redis, namespace });
    try {
      const func = vi.fn(async (args: { n: number }) => args.n * 2);
      const tool: ToolLike<{ n: number }, number> = { name: "double", func };

      const cached = cacheTool(tool, cache);
      expect(await cached.invoke({ n: 21 })).toBe(42);
      expect(await cached.invoke({ n: 21 })).toBe(42);
      expect(func).toHaveBeenCalledTimes(1);
    } finally {
      await cleanupKeys(redis, namespace);
    }
  });

  it("uses invoke() when present and preserves name/description", async () => {
    const namespace = uniqueNamespace("tool-invoke");
    const cache = new ToolCache({ redis, namespace });
    try {
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
    } finally {
      await cleanupKeys(redis, namespace);
    }
  });

  it("throws when the tool has no invoke/func", () => {
    const namespace = uniqueNamespace("tool-broken");
    const cache = new ToolCache({ redis, namespace });
    expect(() => cacheTool({ name: "broken" }, cache)).toThrow();
  });
});
