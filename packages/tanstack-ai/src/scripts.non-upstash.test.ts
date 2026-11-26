/**
 * The stores against a Redis server other than Upstash, reached over REST (for example
 * Redis or Valkey behind serverless-redis-http). Runs only when NON_UPSTASH_REDIS_REST_URL /
 * _TOKEN are set; not part of CI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Redis } from "@upstash/redis";
import { RedisLock } from "./locks/redis-lock.js";
import { EventLog } from "./stream/event-log.js";
import { uniquePrefix } from "./testing/test-support.js";

const url = process.env.NON_UPSTASH_REDIS_REST_URL;
const token = process.env.NON_UPSTASH_REDIS_REST_TOKEN;

describe.skipIf(!url || !token)("lua scripts on a Redis other than Upstash", () => {
  const prefix = uniquePrefix("nonUpstash");
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  for (const enableUpstashScriptFlags of [undefined, false]) {
    it(`${enableUpstashScriptFlags}: the lock and the event log work`, async () => {
      const redis = new Redis({ url: url!, token: token! });
      const lock = new RedisLock({ redis, prefix, enableUpstashScriptFlags });
      const lease = await lock.tryAcquire(`k-${enableUpstashScriptFlags}`);
      expect(lease).not.toBeNull();
      expect(await lock.tryAcquire(`k-${enableUpstashScriptFlags}`)).toBeNull();
      expect(await lease!.extend()).toBe(true);
      expect(await lease!.release()).toBe(true);
      const log = new EventLog<number>({ redis, prefix, enableUpstashScriptFlags });
      expect(await log.append(`l-${enableUpstashScriptFlags}`, [1, 2])).toHaveLength(2);
    });
  }

  it("true: the server's rejection is thrown", async () => {
    const redis = new Redis({ url: url!, token: token! });
    const lock = new RedisLock({ redis, prefix, enableUpstashScriptFlags: true });
    await expect(lock.tryAcquire("k-true")).rejects.toThrow(/shebang|near '#'/);
  });
});
