import { ToolCache } from "@upstash/agentkit-sdk";
import { z } from "zod";
import { afterAll, describe, expect, it, vi } from "vitest";
import { defineCachedTool } from "./tools.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

const CTX = {} as never;

describe.skipIf(!hasRedisCreds)("defineCachedTool (live Redis)", () => {
  const redis = testRedis();
  const namespace = uniqueNamespace("eve-tool");

  afterAll(async () => {
    await cleanupKeys(redis, namespace);
  });

  it("memoizes by cachePrefix + input so execute runs once", async () => {
    const toolCache = new ToolCache({ redis, namespace });
    const fn = vi.fn(async ({ x }: { x: number }) => x * 2);
    const t = defineCachedTool({
      description: "double",
      inputSchema: z.object({ x: z.number() }),
      cachePrefix: "double",
      execute: fn,
      toolCache,
    });

    expect(await t.execute({ x: 21 }, CTX)).toBe(42);
    expect(await t.execute({ x: 21 }, CTX)).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("supports a function cachePrefix", async () => {
    const toolCache = new ToolCache({ redis, namespace });
    const fn = vi.fn(async ({ id }: { id: string }) => id.toUpperCase());
    const t = defineCachedTool({
      description: "upper",
      inputSchema: z.object({ id: z.string() }),
      cachePrefix: ({ id }) => `upper:${id}`,
      execute: fn,
      toolCache,
    });

    await t.execute({ id: "a" }, CTX);
    await t.execute({ id: "a" }, CTX);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
