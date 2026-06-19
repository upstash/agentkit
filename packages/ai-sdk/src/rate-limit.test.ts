import { Ratelimit } from "@upstash/ratelimit";
import { afterAll, describe, expect, it, vi } from "vitest";
import { rateLimitMiddleware, RateLimitExceededError } from "./rate-limit.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

describe.skipIf(!hasRedisCreds)("rateLimitMiddleware (live Redis)", () => {
  const redis = testRedis();
  const prefix = uniqueNamespace("aisdk-rl");

  afterAll(async () => {
    await cleanupKeys(redis, prefix);
  });

  it("allows calls under the limit and throws once exceeded", async () => {
    const ratelimit = new Ratelimit({ redis, limiter: Ratelimit.fixedWindow(2, "60 s"), prefix });
    const mw = rateLimitMiddleware({ ratelimit, identifier: "user-1" });
    const doGenerate = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));

    await mw.wrapGenerate!({ doGenerate, params: {} } as never);
    await mw.wrapGenerate!({ doGenerate, params: {} } as never);
    expect(doGenerate).toHaveBeenCalledTimes(2);

    await expect(mw.wrapGenerate!({ doGenerate, params: {} } as never)).rejects.toBeInstanceOf(
      RateLimitExceededError,
    );
    expect(doGenerate).toHaveBeenCalledTimes(2); // blocked call did not reach the model
  });
});
