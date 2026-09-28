import { afterAll, describe, expect, it } from "vitest";
import { LockAcquireTimeoutError, LockLostError, RedisLock } from "./redis-lock.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniquePrefix } from "../testing/test-support.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!hasRedisCreds)("RedisLock (live Redis)", () => {
  const redis = testRedis();
  const prefix = uniquePrefix("lock");

  afterAll(async () => {
    await cleanupKeys(redis, prefix);
  });

  it("grants the key to one holder at a time, with increasing fencing tokens", async () => {
    const lock = new RedisLock({ redis, prefix });
    const a = await lock.tryAcquire("k1");
    expect(a).not.toBeNull();
    expect(await lock.tryAcquire("k1")).toBeNull();
    expect(await a!.release()).toBe(true);
    const b = await lock.tryAcquire("k1");
    expect(b!.fencingToken).toBeGreaterThan(a!.fencingToken);
    await b!.release();
  });

  it("a stale holder cannot release or extend the next holder's lease", async () => {
    const lock = new RedisLock({ redis, prefix });
    const stale = await lock.tryAcquire("k2", { leaseMs: 300 });
    await sleep(500);
    const fresh = await lock.tryAcquire("k2");
    expect(fresh).not.toBeNull();
    expect(await stale!.release()).toBe(false);
    expect(await stale!.extend()).toBe(false);
    expect(await lock.tryAcquire("k2")).toBeNull();
    await fresh!.release();
  });

  it("withLock serializes concurrent critical sections", async () => {
    const lock = new RedisLock({ redis, prefix, retryDelayMs: 20 });
    let inside = 0;
    let maxInside = 0;
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        lock.withLock("k3", async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await sleep(100);
          order.push(n);
          inside -= 1;
        }),
      ),
    );
    expect(maxInside).toBe(1);
    expect(order.sort()).toEqual([1, 2, 3]);
    expect(await redis.exists(`${prefix}:lease:k3`)).toBe(0);
  });

  it("releases the lease when the critical section throws", async () => {
    const lock = new RedisLock({ redis, prefix });
    await expect(
      lock.withLock("k4", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await lock.tryAcquire("k4")).not.toBeNull();
  });

  it("renews the lease while the section runs past its lifetime", async () => {
    const lock = new RedisLock({ redis, prefix, leaseMs: 600 });
    await lock.withLock("k5", async (signal) => {
      await sleep(1_500);
      expect(signal.aborted).toBe(false);
      expect(await lock.tryAcquire("k5")).toBeNull();
    });
  });

  it("aborts the signal when the lease is taken away", async () => {
    const lock = new RedisLock({ redis, prefix, leaseMs: 600 });
    const reason = await lock.withLock("k6", async (signal) => {
      await redis.del(`${prefix}:lease:k6`); // simulate expiry + takeover
      await sleep(800);
      return signal.reason;
    });
    expect(reason).toBeInstanceOf(LockLostError);
  });

  it("keeps leases and fencing counters apart for colliding-looking keys", async () => {
    const lock = new RedisLock({ redis, prefix });
    const x = await lock.tryAcquire("x");
    expect(x).not.toBeNull();
    const fenceX = await lock.tryAcquire("fence:x");
    expect(fenceX).not.toBeNull(); // would be refused if its lease were x's fencing counter
    expect(await x!.release()).toBe(true);
    expect(await fenceX!.release()).toBe(true);
    const again = await lock.tryAcquire("x");
    expect(again!.fencingToken).toBeGreaterThan(x!.fencingToken);
    await again!.release();
  });

  it("times out acquiring a held key", async () => {
    const lock = new RedisLock({ redis, prefix, acquireTimeoutMs: 300, retryDelayMs: 50 });
    const held = await lock.tryAcquire("k7");
    await expect(lock.withLock("k7", async () => 1)).rejects.toBeInstanceOf(
      LockAcquireTimeoutError,
    );
    await held!.release();
  });
});
