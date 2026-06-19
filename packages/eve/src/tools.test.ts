import { z } from "zod";
import { afterAll, describe, expect, it, vi } from "vitest";
import { defineCachedTool } from "./tools.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

const CTX = {} as never;

describe.skipIf(!hasRedisCreds)("defineCachedTool (live Redis)", () => {
  const redis = testRedis();
  // The tool owns its ToolCache (default `agentkit:toolCache` base); isolate this run by cache namespace.
  const ns = uniqueNamespace("eve-tool").replace("test:", "");

  afterAll(async () => {
    await cleanupKeys(redis, `agentkit:toolCache:${ns}`);
  });

  it("memoizes by namespace + input so execute runs once", async () => {
    const fn = vi.fn(async ({ x }: { x: number }) => x * 2);
    const t = defineCachedTool({
      description: "double",
      inputSchema: z.object({ x: z.number() }),
      namespace: `${ns}:double`,
      execute: fn,
      redis,
    });

    expect(await t.execute({ x: 21 }, CTX)).toBe(42);
    expect(await t.execute({ x: 21 }, CTX)).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("supports a function namespace", async () => {
    const fn = vi.fn(async ({ id }: { id: string }) => id.toUpperCase());
    const t = defineCachedTool({
      description: "upper",
      inputSchema: z.object({ id: z.string() }),
      namespace: ({ id }) => `${ns}:upper:${id}`,
      execute: fn,
      redis,
    });

    await t.execute({ id: "a" }, CTX);
    await t.execute({ id: "a" }, CTX);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
