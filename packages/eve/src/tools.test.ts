import { ToolCache } from "@upstash/agentkit-sdk";
import { afterAll, describe, expect, it, vi } from "vitest";
import { cachedExecute } from "./tools.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

describe.skipIf(!hasRedisCreds)("cachedExecute (live Redis)", () => {
  const redis = testRedis();
  const namespace = uniqueNamespace("eve-tool");

  afterAll(async () => {
    await cleanupKeys(redis, namespace);
  });

  it("memoizes identical inputs so the underlying execute runs once", async () => {
    const toolCache = new ToolCache({ redis, namespace });
    const fn = vi.fn(async ({ x }: { x: number }) => x * 2);
    const execute = cachedExecute("double", fn, { toolCache });

    expect(await execute({ x: 21 })).toBe(42);
    expect(await execute({ x: 21 })).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not share cache across different inputs", async () => {
    const toolCache = new ToolCache({ redis, namespace });
    const fn = vi.fn(async ({ x }: { x: number }) => x + 1);
    const execute = cachedExecute("inc", fn, { toolCache });

    await execute({ x: 1 });
    await execute({ x: 2 });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
