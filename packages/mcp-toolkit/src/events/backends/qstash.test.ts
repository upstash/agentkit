import { afterAll, describe, expect, it } from "vitest";
import { QStashDelivery, RedisSubscriptionStore } from "./qstash.js";
import type { DeliveryJob, Subscription } from "../types.js";
import {
  cleanupKeys,
  hasRedisCreds,
  qstashRequest,
  testReceiver,
  testRedis,
  uniquePrefix,
} from "../../test-support.js";

const makeSub = (overrides: Partial<Subscription> = {}): Subscription => ({
  id: `sub_${Math.random().toString(36).slice(2, 10)}`,
  event: "push",
  args: { repo: "upstash/agentkit" },
  url: "https://receiver.example.com/cb",
  encryptedSecret: "v1.aaa.bbb",
  subscriber: "123",
  createdAt: new Date().toISOString(),
  expiresAt: Date.now() + 60_000,
  ...overrides,
});

describe.skipIf(!hasRedisCreds)("RedisSubscriptionStore (real Redis)", () => {
  const redis = testRedis();
  const prefix = uniquePrefix("events");
  const store = new RedisSubscriptionStore({ redis, prefix });
  const subKey = (id: string) => `${prefix}sub:${id}`;
  const indexKey = (event: string) => `${prefix}idx:${event}`;

  afterAll(async () => {
    await cleanupKeys(redis, prefix);
  });

  it("round-trips a subscription, keeping a numeric-looking subscriber a string", async () => {
    const sub = makeSub();
    await store.put(sub);
    expect(await store.get(sub.id)).toEqual(sub);
    expect(await store.get("sub_missing")).toBeNull();
  });

  it("expires the record with the subscription", async () => {
    const sub = makeSub({ expiresAt: Date.now() + 30_000 });
    await store.put(sub);
    const pttl = await redis.pttl(subKey(sub.id));
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(30_000);
  });

  it("finds every live subscription to an event, and nothing else", async () => {
    const all = makeSub({ event: "find", args: {} });
    const one = makeSub({ event: "find", args: { repo: "a" } });
    const elsewhere = makeSub({ event: "other", args: {} });
    const expired = makeSub({ event: "find" });
    for (const sub of [all, one, elsewhere]) await store.put(sub);
    // Written live, then left in the index past its expiry.
    await redis.zadd(indexKey("find"), { score: Date.now() - 1, member: expired.id });

    const found = await store.find("find");
    expect(found.map((s) => s.id).sort()).toEqual([all.id, one.id].sort());
    expect(await store.find("nothing")).toEqual([]);
  });

  it("reads a large event in bounded batches", async () => {
    // 1,100 subscriptions is more than one MGET's worth.
    const subs = Array.from({ length: 1100 }, (_, i) =>
      makeSub({ event: "popular", args: {}, subscriber: `member-${i}` }),
    );
    for (let i = 0; i < subs.length; i += 100) {
      await Promise.all(subs.slice(i, i + 100).map((sub) => store.put(sub)));
    }
    const found = await store.find("popular");
    expect(found).toHaveLength(1100);
    expect(new Set(found.map((s) => s.id))).toEqual(new Set(subs.map((s) => s.id)));
  });

  it("refreshing replaces the record and keeps one index entry", async () => {
    const sub = makeSub({ event: "refresh", expiresAt: Date.now() + 10_000 });
    await store.put(sub);
    await store.put({ ...sub, expiresAt: Date.now() + 50_000 });
    expect((await store.get(sub.id))?.expiresAt).toBeGreaterThan(Date.now() + 40_000);
    expect(await store.find("refresh")).toHaveLength(1);
  });

  it("prunes expired index entries on the next write", async () => {
    await redis.zadd(indexKey("prune"), { score: Date.now() - 1000, member: "sub_old" });
    await store.put(makeSub({ event: "prune" }));
    expect(await redis.zscore(indexKey("prune"), "sub_old")).toBeNull();
  });

  it("deletes the record and its index entry", async () => {
    const sub = makeSub({ event: "delete" });
    await store.put(sub);
    await store.delete(sub);
    expect(await store.get(sub.id)).toBeNull();
    expect(await store.find("delete")).toEqual([]);
    expect(await redis.zcard(indexKey("delete"))).toBe(0);
    await store.delete(sub); // idempotent
  });
});

describe("QStashDelivery", () => {
  const URL = "https://example.com/api/events";

  const job: DeliveryJob = {
    subscriptionId: "sub_1",
    envelope: {
      eventId: "evt_1",
      name: "push",
      timestamp: "2026-10-07T00:00:00Z",
      data: {},
      cursor: null,
    },
  };

  const connected = (done: boolean) => {
    const sent: DeliveryJob[] = [];
    const delivery = new QStashDelivery({ url: URL, receiver: testReceiver() });
    const handler = delivery.createDeliveryHandler(async (j) => {
      sent.push(j);
      return done;
    });
    return { handler, sent };
  };

  it("acknowledges a finished job with 200", async () => {
    const { handler, sent } = connected(true);
    expect((await handler(qstashRequest(URL, job))).status).toBe(200);
    expect(sent).toEqual([job]);
  });

  it("answers 500 so QStash retries a failed callback", async () => {
    const { handler } = connected(false);
    expect((await handler(qstashRequest(URL, job))).status).toBe(500);
  });

  it("verifies against the published URL, so it works behind a proxy", async () => {
    const { handler, sent } = connected(true);
    const signed = qstashRequest(URL, job);
    const proxied = new Request("http://10.0.0.5:3000/api/events", {
      method: "POST",
      headers: signed.headers,
      body: await signed.text(),
    });
    expect((await handler(proxied)).status).toBe(200);
    expect(sent).toEqual([job]);
  });

  it("refuses, as non-retryable, anything QStash did not sign for this endpoint", async () => {
    const forged = [
      new Request(URL, { method: "POST", body: JSON.stringify(job) }),
      qstashRequest(URL, job, { key: "stolen" }),
      qstashRequest(URL, job, { sub: "https://example.com/api/execute" }),
      qstashRequest(URL, job, { body: "aGFzaCBvZiBzb21ldGhpbmcgZWxzZQ" }),
      qstashRequest(URL, job, { exp: Math.floor(Date.now() / 1000) - 600 }),
    ];
    for (const request of forged) {
      const { handler, sent } = connected(true);
      const response = await handler(request);
      expect(response.status).toBe(489);
      expect(response.headers.get("Upstash-NonRetryable-Error")).toBe("true");
      expect(sent).toEqual([]);
    }
  });

  it("refuses a signed body that is not a delivery job", async () => {
    const { handler, sent } = connected(true);
    expect((await handler(qstashRequest(URL, { nope: true }))).status).toBe(489);
    expect((await handler(qstashRequest(URL, "not json"))).status).toBe(489);
    expect(sent).toEqual([]);
  });

  it("publishes one deduplicated message per subscription, in batches of 100", async () => {
    const batches: Record<string, unknown>[][] = [];
    const qstash = {
      batchJSON: async (messages: Record<string, unknown>[]) => {
        batches.push(messages);
        return [];
      },
    } as unknown as ConstructorParameters<typeof QStashDelivery>[0]["qstash"];
    const delivery = new QStashDelivery({ url: URL, qstash });
    const jobs = Array.from({ length: 150 }, (_, i) => ({ ...job, subscriptionId: `sub_${i}` }));
    await delivery.enqueue(jobs);
    expect(batches.map((b) => b.length)).toEqual([100, 50]);
    expect(batches[0]?.[0]).toMatchObject({
      url: URL,
      body: jobs[0],
      retries: 3,
      deduplicationId: "evt_1_sub_0",
    });
  });
});
