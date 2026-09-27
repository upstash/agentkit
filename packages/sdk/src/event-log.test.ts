import { afterAll, describe, expect, it } from "vitest";
import { EventLog } from "./event-log.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniquePrefix } from "./test-support.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!hasRedisCreds)("EventLog (live Redis)", () => {
  const redis = testRedis();
  const prefix = uniquePrefix("log");

  afterAll(async () => {
    await cleanupKeys(redis, prefix);
  });

  it("round-trips values exactly, including JSON-looking strings and numbers", async () => {
    const log = new EventLog<unknown>({ redis, prefix });
    const events = [{ type: "A", n: 1 }, "123", '{"a":1}', 42, null, [1, "x"]];
    const ids = await log.append("exact", events);
    expect(ids).toHaveLength(events.length);
    expect((await log.snapshot("exact")).map((e) => e.event)).toEqual(events);
  });

  it("snapshot is [] for an unknown log and never waits", async () => {
    const log = new EventLog({ redis, prefix });
    expect(await log.snapshot("nope")).toEqual([]);
    expect(await log.tail("nope")).toBeNull();
  });

  it("read resumes strictly after a position and stops once closed", async () => {
    const log = new EventLog<number>({ redis, prefix, pollIntervalMs: 50 });
    const ids = await log.append("resume", [1, 2, 3]);
    const seen: number[] = [];
    const reader = (async () => {
      for await (const e of log.read("resume", { after: ids[0] })) seen.push(e.event);
    })();
    await sleep(150);
    await log.append("resume", [4, 5]);
    await log.close("resume");
    await reader;
    expect(seen).toEqual([2, 3, 4, 5]);
    expect(await log.isClosed("resume")).toBe(true);
  });

  it("two readers see the same live stream (fan-out)", async () => {
    const log = new EventLog<string>({ redis, prefix, pollIntervalMs: 50 });
    const collect = async () => {
      const out: string[] = [];
      for await (const e of log.read("fan")) out.push(e.event);
      return out;
    };
    const a = collect();
    const b = collect();
    await log.append("fan", ["x"]);
    await sleep(120);
    await log.append("fan", ["y", "z"]);
    await log.close("fan");
    expect(await a).toEqual(["x", "y", "z"]);
    expect(await b).toEqual(["x", "y", "z"]);
  });

  it("stops tailing when the signal aborts", async () => {
    const log = new EventLog<number>({ redis, prefix, pollIntervalMs: 50 });
    await log.append("abort", [1]);
    const controller = new AbortController();
    const seen: number[] = [];
    const reader = (async () => {
      for await (const e of log.read("abort", { signal: controller.signal })) seen.push(e.event);
    })();
    await sleep(150);
    controller.abort();
    await reader;
    expect(seen).toEqual([1]);
  });

  it("rejects a join on a log that never produces", async () => {
    const log = new EventLog({ redis, prefix, pollIntervalMs: 50 });
    const read = async () => {
      for await (const _ of log.read("ghost", { firstEntryTimeoutMs: 200 })) void _;
    };
    await expect(read()).rejects.toThrow(/no entries/);
  });

  it("pages through logs larger than one XRANGE page", async () => {
    const log = new EventLog<number>({ redis, prefix });
    const big = Array.from({ length: 1_200 }, (_, i) => i);
    await log.append("big", big.slice(0, 600));
    await log.append("big", big.slice(600));
    expect((await log.snapshot("big")).map((e) => e.event)).toEqual(big);
    await log.close("big");
    const read: number[] = [];
    for await (const e of log.read("big")) read.push(e.event);
    expect(read).toEqual(big);
  });

  it("expires logs whose producer never closed", async () => {
    const log = new EventLog({ redis, prefix, ttlSeconds: 60 });
    await log.append("ttl", [1]);
    const ttl = await redis.ttl(`${prefix}:events:ttl`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });
});
