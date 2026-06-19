import { z } from "zod";
import { afterAll, describe, expect, it, vi } from "vitest";
import { cachedTool } from "./tools.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

const TOOL_OPTS = { toolCallId: "t", messages: [] } as never;
function call<R>(execute: unknown, input: unknown): Promise<R> {
  return (execute as (i: unknown, o: unknown) => Promise<R>)(input, TOOL_OPTS);
}

describe.skipIf(!hasRedisCreds)("cachedTool (live Redis)", () => {
  const redis = testRedis();

  afterAll(async () => {
    // cachedTool uses the default ToolCache namespace; our cachePrefixes are unique per test.
    await cleanupKeys(redis, "agentkit:tool:aisdk-tool");
  });

  it("memoizes execute by cachePrefix + input", async () => {
    const getWeather = vi.fn(async ({ city }: { city: string }) => ({ city, tempF: 70 }));
    const weather = cachedTool({
      description: "weather",
      inputSchema: z.object({ city: z.string() }),
      cachePrefix: uniqueNamespace("aisdk-tool").replace("test:", ""),
      execute: getWeather,
      redis,
    });

    const a = await call<{ city: string }>(weather.execute, { city: "NYC" });
    const b = await call<{ city: string }>(weather.execute, { city: "NYC" });
    expect(a).toEqual({ city: "NYC", tempF: 70 });
    expect(b).toEqual({ city: "NYC", tempF: 70 });
    expect(getWeather).toHaveBeenCalledTimes(1);
  });

  it("does not share cache across different inputs", async () => {
    const inc = vi.fn(async ({ n }: { n: number }) => n + 1);
    const tool = cachedTool({
      description: "inc",
      inputSchema: z.object({ n: z.number() }),
      cachePrefix: uniqueNamespace("aisdk-tool").replace("test:", ""),
      execute: inc,
      redis,
    });
    await call(tool.execute, { n: 1 });
    await call(tool.execute, { n: 2 });
    expect(inc).toHaveBeenCalledTimes(2);
  });
});
