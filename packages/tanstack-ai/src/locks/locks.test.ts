import { describe, expect, it } from "vitest";
import { afterAll } from "vitest";
import { upstashLocks } from "./locks.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniquePrefix } from "../testing/test-support.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!hasRedisCreds)("upstashLocks (live Redis)", () => {
  const redis = testRedis();
  const prefix = uniquePrefix("tslock");
  afterAll(async () => {
    await cleanupKeys(redis, prefix);
  });

  it("two LockStores (two instances) never run the same key's section concurrently", async () => {
    const a = upstashLocks({ redis, prefix, retryDelayMs: 20 });
    const b = upstashLocks({ redis: testRedis(), prefix, retryDelayMs: 20 });
    let inside = 0;
    let max = 0;
    const section = async () => {
      inside++;
      max = Math.max(max, inside);
      await sleep(80);
      inside--;
      return "done";
    };
    const results = await Promise.all([
      a.withLock("thread:1", section),
      b.withLock("thread:1", section),
      a.withLock("thread:1", section),
    ]);
    expect(results).toEqual(["done", "done", "done"]);
    expect(max).toBe(1);
  });

  it("different keys do not block each other", async () => {
    // Check that the two sections overlap, not a wall-clock bound, which depends on Redis latency.
    const locks = upstashLocks({ redis, prefix });
    let active = 0;
    let maxActive = 0;
    const section = async () => {
      maxActive = Math.max(maxActive, ++active);
      await sleep(300);
      active--;
    };
    await Promise.all([locks.withLock("k:a", section), locks.withLock("k:b", section)]);
    expect(maxActive).toBe(2);
  });

  it("passes a live signal and releases on failure", async () => {
    const locks = upstashLocks({ redis, prefix });
    await expect(
      locks.withLock("k:c", async (signal) => {
        expect(signal.aborted).toBe(false);
        throw new Error("x");
      }),
    ).rejects.toThrow("x");
    expect(await locks.withLock("k:c", async () => 1)).toBe(1);
  });
});
