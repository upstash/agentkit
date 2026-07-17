import { z } from "zod";
import { afterAll, describe, expect, it, vi } from "vitest";
import { defineCachedTool } from "./tools.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueUserId } from "./test-support.js";

const CTX = {} as never;

describe.skipIf(!hasRedisCreds)("defineCachedTool (live Redis)", () => {
  const redis = testRedis();
  // The tool owns its ToolCache (default `agentkit:toolCache` base); isolate this run by userId.
  const ns = uniqueUserId("eve-tool");

  afterAll(async () => {
    await cleanupKeys(redis, `agentkit:toolCache:${ns}`);
  });

  it("memoizes by userId + toolName + input so execute runs once", async () => {
    const fn = vi.fn(async ({ x }: { x: number }) => x * 2);
    const t = defineCachedTool({
      description: "double",
      inputSchema: z.object({ x: z.number() }),
      toolName: "double",
      userId: ns,
      execute: fn,
      redis,
    });

    expect(await t.execute({ x: 21 }, CTX)).toBe(42);
    expect(await t.execute({ x: 21 }, CTX)).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("supports a function userId (derived from input/ctx)", async () => {
    const fn = vi.fn(async ({ id }: { id: string }) => id.toUpperCase());
    const t = defineCachedTool({
      description: "upper",
      inputSchema: z.object({ id: z.string() }),
      toolName: "upper",
      userId: ({ id }) => `${ns}-${id}`,
      execute: fn,
      redis,
    });

    await t.execute({ id: "a" }, CTX);
    await t.execute({ id: "a" }, CTX);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
