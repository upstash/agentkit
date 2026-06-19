import { afterAll, describe, expect, it } from "vitest";
import { createRateLimit } from "./rate-limit.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

describe.skipIf(!hasRedisCreds)("createRateLimit (live Redis)", () => {
  const redis = testRedis();
  const namespace = uniqueNamespace("sdk-rl");

  afterAll(async () => {
    await cleanupKeys(redis, namespace);
  });

  it("allows the first call and blocks the next once over the limit", async () => {
    const ratelimit = createRateLimit({ redis, limit: 1, window: "60 s", namespace });
    const id = "user-1";

    const first = await ratelimit.limit(id);
    expect(first.success).toBe(true);

    const second = await ratelimit.limit(id);
    expect(second.success).toBe(false);
  });
});
