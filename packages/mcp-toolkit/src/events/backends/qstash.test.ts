import { afterAll, describe, expect, it } from "vitest";
import { QStashDelivery, RedisSubscriptionStore } from "./qstash.js";
import type { DeliveryJob, SendOutcome, Subscription } from "../types.js";
import { canonicalJson } from "../core.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniquePrefix } from "../../test-support.js";

const makeSub = (overrides: Partial<Subscription> = {}): Subscription => {
  const args = overrides.args ?? { repo: "upstash/agentkit" };
  return {
    id: `sub_${Math.random().toString(36).slice(2, 10)}`,
    event: "push",
    args,
    argsKey: canonicalJson(args),
    url: "https://receiver.example.com/cb",
    encryptedSecret: "v1.aaa.bbb",
    subscriber: "123",
    context: { org: "acme" },
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
};

describe.skipIf(!hasRedisCreds)("RedisSubscriptionStore (real Redis)", () => {
  const redis = testRedis();
  const prefix = uniquePrefix("events");
  const store = new RedisSubscriptionStore({ redis, prefix });

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
    const pttl = await redis.pttl(store.subKey(sub.id));
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(30_000);
    expect(await redis.pttl(await store.indexKey(sub))).toBeGreaterThan(0);
  });

  it("finds subscriptions by any of several argument keys, and only live ones", async () => {
    const all = makeSub({ event: "find", args: {} });
    const one = makeSub({ event: "find", args: { repo: "a" } });
    const other = makeSub({ event: "find", args: { repo: "b" } });
    for (const sub of [all, one, other]) await store.put(sub);

    const found = await store.find("find", ["{}", canonicalJson({ repo: "a" })]);
    expect(found.map((s) => s.id).sort()).toEqual([all.id, one.id].sort());
    expect(await store.find("find", [])).toEqual([]);
    expect(await store.find("other-event", ["{}"])).toEqual([]);
  });

  it("reads a large match in bounded batches", async () => {
    // 1,100 matching subscriptions is more than one MGET's worth.
    const subs = Array.from({ length: 1100 }, (_, i) =>
      makeSub({ event: "popular", args: {}, subscriber: `member-${i}` }),
    );
    for (let i = 0; i < subs.length; i += 100) {
      await Promise.all(subs.slice(i, i + 100).map((sub) => store.put(sub)));
    }
    const found = await store.find("popular", ["{}"]);
    expect(found).toHaveLength(1100);
    expect(new Set(found.map((s) => s.id))).toEqual(new Set(subs.map((s) => s.id)));
  });

  it("refreshing replaces the record and extends the index", async () => {
    const sub = makeSub({ event: "refresh", expiresAt: Date.now() + 10_000 });
    await store.put(sub);
    await store.put({ ...sub, expiresAt: Date.now() + 50_000 });
    expect((await store.get(sub.id))?.expiresAt).toBeGreaterThan(Date.now() + 40_000);
    expect(await store.find("refresh", [sub.argsKey])).toHaveLength(1);
    expect(await redis.pttl(await store.indexKey(sub))).toBeGreaterThan(40_000);
  });

  it("deletes the record and its index entry", async () => {
    const sub = makeSub({ event: "delete" });
    await store.put(sub);
    await store.delete(sub);
    expect(await store.get(sub.id)).toBeNull();
    expect(await store.find("delete", [sub.argsKey])).toEqual([]);
    expect(await redis.zcard(await store.indexKey(sub))).toBe(0);
    await store.delete(sub); // idempotent
  });
});

describe("QStashDelivery", () => {
  const receiver = (accept: boolean) =>
    ({
      verify: async () => {
        if (!accept) throw new Error("bad signature");
        return true;
      },
    }) as unknown as ConstructorParameters<typeof QStashDelivery>[0]["receiver"];

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

  const attached = (outcome: SendOutcome, accept = true) => {
    const sent: DeliveryJob[] = [];
    const delivery = new QStashDelivery({
      url: "https://example.com/api/events",
      receiver: receiver(accept),
    });
    delivery.attach({
      send: async (j) => {
        sent.push(j);
        return outcome;
      },
    });
    return { handler: delivery.createDeliveryHandler(), sent };
  };

  const post = (body: unknown) =>
    new Request("https://internal.example/api/events", {
      method: "POST",
      headers: { "upstash-signature": "sig" },
      body: JSON.stringify(body),
    });

  it("acknowledges delivered, gone and dropped with 200", async () => {
    for (const outcome of ["delivered", "gone", "dropped"] as const) {
      const { handler, sent } = attached(outcome);
      expect((await handler(post(job))).status).toBe(200);
      expect(sent).toEqual([job]);
    }
  });

  it("answers 500 so QStash retries a failed callback", async () => {
    const { handler } = attached("retry");
    expect((await handler(post(job))).status).toBe(500);
  });

  it("rejects an unsigned or malformed delivery as non-retryable", async () => {
    const unsigned = attached("delivered", false);
    const refused = await unsigned.handler(post(job));
    expect(refused.status).toBe(489);
    expect(refused.headers.get("Upstash-NonRetryable-Error")).toBe("true");
    expect(unsigned.sent).toEqual([]);
    const { handler } = attached("delivered");
    expect((await handler(post({ nope: true }))).status).toBe(489);
  });

  it("publishes one deduplicated message per subscription, in batches of 100", async () => {
    const batches: Record<string, unknown>[][] = [];
    const qstash = {
      batchJSON: async (messages: Record<string, unknown>[]) => {
        batches.push(messages);
        return [];
      },
    } as unknown as ConstructorParameters<typeof QStashDelivery>[0]["qstash"];
    const delivery = new QStashDelivery({
      url: "https://example.com/api/events",
      qstash,
      retries: 5,
    });
    const jobs = Array.from({ length: 150 }, (_, i) => ({ ...job, subscriptionId: `sub_${i}` }));
    await delivery.enqueue(jobs);
    expect(batches.map((b) => b.length)).toEqual([100, 50]);
    expect(batches[0]?.[0]).toMatchObject({
      url: "https://example.com/api/events",
      body: jobs[0],
      retries: 5,
      deduplicationId: "evt_1_sub_0",
    });
  });
});
