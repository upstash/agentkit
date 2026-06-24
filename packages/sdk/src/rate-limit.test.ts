import { afterAll, describe, expect, it } from "vitest";
import { Ratelimit, createRateLimit } from "./rate-limit.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniquePrefix } from "./test-support.js";

describe.skipIf(!hasRedisCreds)("createRateLimit (live Redis)", () => {
  const redis = testRedis();
  const prefix = uniquePrefix("sdk-rl");

  afterAll(async () => {
    await cleanupKeys(redis, prefix);
  });

  it("allows the first call and blocks the next once over the limit", async () => {
    const ratelimit = createRateLimit({
      redis,
      limiter: Ratelimit.slidingWindow(1, "60 s"),
      prefix,
    });
    const id = "user-1";

    const first = await ratelimit.limit(id);
    expect(first.success).toBe(true);

    const second = await ratelimit.limit(id);
    expect(second.success).toBe(false);
  });
});
