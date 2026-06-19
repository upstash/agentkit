import { ToolCache } from "@upstash/agentkit-sdk";
import { afterAll, describe, expect, it, vi } from "vitest";
import { cacheTools } from "./tools.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

describe.skipIf(!hasRedisCreds)("cacheTools (live Redis)", () => {
  const redis = testRedis();
  const namespace = uniqueNamespace("aisdk-tool");

  afterAll(async () => {
    await cleanupKeys(redis, namespace);
  });

  it("returns a new map with the same keys whose execute is memoized", async () => {
    const toolCache = new ToolCache({ redis, namespace });
    const getWeather = vi.fn(async (args: unknown, _options: unknown) => ({
      city: (args as { city: string }).city,
      tempF: 70,
    }));
    const tools = {
      getWeather: { description: "weather", execute: getWeather },
      noExec: { description: "client tool" }, // no execute -> passed through
    };

    const wrapped = cacheTools(tools, { toolCache });
    expect(Object.keys(wrapped).sort()).toEqual(["getWeather", "noExec"]);
    expect(wrapped.noExec).toBe(tools.noExec);

    const a = await wrapped.getWeather!.execute!({ city: "NYC" }, {});
    const b = await wrapped.getWeather!.execute!({ city: "NYC" }, {});
    expect(a).toEqual({ city: "NYC", tempF: 70 });
    expect(b).toEqual({ city: "NYC", tempF: 70 });
    expect(getWeather).toHaveBeenCalledTimes(1);
  });

  it("keys cache entries per tool + args", async () => {
    const toolCache = new ToolCache({ redis, namespace });
    const inc = vi.fn(async (args: unknown, _options: unknown) => (args as { n: number }).n + 1);
    const wrapped = cacheTools({ inc: { execute: inc } }, { toolCache });
    await wrapped.inc!.execute!({ n: 1 }, {});
    await wrapped.inc!.execute!({ n: 2 }, {});
    expect(inc).toHaveBeenCalledTimes(2);
  });
});
