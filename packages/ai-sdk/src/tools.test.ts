import { tool } from "ai";
import { z } from "zod";
import { ToolCache } from "@upstash/agentkit-sdk";
import { afterAll, describe, expect, it, vi } from "vitest";
import { cacheTools } from "./tools.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

const TOOL_OPTS = { toolCallId: "t", messages: [] } as never;
function call<R>(execute: unknown, input: unknown): Promise<R> {
  return (execute as (i: unknown, o: unknown) => Promise<R>)(input, TOOL_OPTS);
}

describe.skipIf(!hasRedisCreds)("cacheTools (live Redis)", () => {
  const redis = testRedis();
  const namespace = uniqueNamespace("aisdk-tool");

  afterAll(async () => {
    await cleanupKeys(redis, namespace);
  });

  it("returns a new map with the same keys whose execute is memoized", async () => {
    const toolCache = new ToolCache({ redis, namespace });
    const getWeather = vi.fn(async ({ city }: { city: string }) => ({ city, tempF: 70 }));
    const tools = {
      getWeather: tool({
        description: "weather",
        inputSchema: z.object({ city: z.string() }),
        execute: getWeather,
      }),
      noExec: tool({ description: "client tool", inputSchema: z.object({}) }), // no execute -> passed through
    };

    const wrapped = cacheTools(tools, { toolCache });
    expect(Object.keys(wrapped).sort()).toEqual(["getWeather", "noExec"]);
    expect(wrapped.noExec).toBe(tools.noExec);

    const a = await call<{ city: string }>(wrapped.getWeather!.execute, { city: "NYC" });
    const b = await call<{ city: string }>(wrapped.getWeather!.execute, { city: "NYC" });
    expect(a).toEqual({ city: "NYC", tempF: 70 });
    expect(b).toEqual({ city: "NYC", tempF: 70 });
    expect(getWeather).toHaveBeenCalledTimes(1);
  });

  it("keys cache entries per tool + args", async () => {
    const toolCache = new ToolCache({ redis, namespace });
    const inc = vi.fn(async ({ n }: { n: number }) => n + 1);
    const tools = {
      inc: tool({ description: "inc", inputSchema: z.object({ n: z.number() }), execute: inc }),
    };
    const wrapped = cacheTools(tools, { toolCache });
    await call(wrapped.inc!.execute, { n: 1 });
    await call(wrapped.inc!.execute, { n: 2 });
    expect(inc).toHaveBeenCalledTimes(2);
  });
});
