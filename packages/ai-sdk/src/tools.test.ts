import { tool } from "ai";
import { z } from "zod";
import { afterAll, describe, expect, it, vi } from "vitest";
import { cachedTools } from "./tools.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueUserId } from "./test-support.js";

const TOOL_OPTS = { toolCallId: "t", messages: [] } as never;
function call<R>(execute: unknown, input: unknown): Promise<R> {
  return (execute as (i: unknown, o: unknown) => Promise<R>)(input, TOOL_OPTS);
}

describe.skipIf(!hasRedisCreds)("cachedTools (live Redis)", () => {
  const redis = testRedis();
  // The cache key is `agentkit:toolCache:<userId>:<toolName>:<hash>`; isolate this run by userId.
  const userId = uniqueUserId("aisdk-tool");

  afterAll(async () => {
    await cleanupKeys(redis, `agentkit:toolCache:${userId}`);
  });

  it("memoizes each tool under its map key (toolName), scoped by userId", async () => {
    const getWeather = vi.fn(async ({ city }: { city: string }) => ({ city, tempF: 70 }));
    const tools = cachedTools(
      {
        weather: tool({
          description: "weather",
          inputSchema: z.object({ city: z.string() }),
          execute: getWeather,
        }),
      },
      { userId, redis },
    );

    const a = await call<{ city: string }>(tools.weather!.execute, { city: "NYC" });
    const b = await call<{ city: string }>(tools.weather!.execute, { city: "NYC" });
    expect(a).toEqual({ city: "NYC", tempF: 70 });
    expect(b).toEqual({ city: "NYC", tempF: 70 });
    expect(getWeather).toHaveBeenCalledTimes(1);
  });

  it("does not share cache across different inputs", async () => {
    const inc = vi.fn(async ({ n }: { n: number }) => n + 1);
    const tools = cachedTools(
      { inc: tool({ description: "inc", inputSchema: z.object({ n: z.number() }), execute: inc }) },
      { userId, redis },
    );
    await call(tools.inc!.execute, { n: 1 });
    await call(tools.inc!.execute, { n: 2 });
    expect(inc).toHaveBeenCalledTimes(2);
  });

  it("does not share cache across users", async () => {
    const fn = vi.fn(async ({ city }: { city: string }) => ({ city, tempF: 70 }));
    const make = (u: string) =>
      cachedTools(
        {
          weather: tool({
            description: "weather",
            inputSchema: z.object({ city: z.string() }),
            execute: fn,
          }),
        },
        { userId: u, redis },
      );
    await call(make(`${userId}-a`).weather!.execute, { city: "LA" });
    await call(make(`${userId}-b`).weather!.execute, { city: "LA" });
    expect(fn).toHaveBeenCalledTimes(2); // different users → separate cache entries

    await cleanupKeys(redis, `agentkit:toolCache:${userId}-a`);
    await cleanupKeys(redis, `agentkit:toolCache:${userId}-b`);
  });
});
