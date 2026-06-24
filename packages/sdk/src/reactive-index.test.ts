import { afterEach, describe, expect, it, vi } from "vitest";
import { s } from "@upstash/redis";
import type { Redis } from "@upstash/redis";
import { ReactiveSearchIndex } from "./reactive-index.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniquePrefix } from "./test-support.js";

/**
 * These run against real Upstash Redis (per the project's no-mock-Redis policy). We never fake a
 * Redis response — we only *observe* requests, by spying on the real `createIndex`/op functions with
 * `vi.spyOn` left calling through. That lets us assert the central invariant of the reactive index:
 *
 *   1. A *missing* index is signalled differently per op, and the wrapper provisions + retries
 *      exactly once on that signal.
 *   2. An *existing but empty* index returns ordinary empties — NOT the missing-index sentinels —
 *      so the wrapper must NOT re-provision (no duplicate create-index request) just because there
 *      happens to be no data.
 *
 * How each raw op behaves in the two states (verified by the first two tests below):
 *
 *   | op          | no index (missing)  | index exists, no data |
 *   | ----------- | ------------------- | --------------------- |
 *   | `query`     | `null`              | `[]`                  |
 *   | `count`     | `{ count: -1 }`     | `{ count: 0 }`        |
 *   | `aggregate` | throws              | resolves (empty)      |
 *
 * Counting `createIndex` calls needs a trick: `redis.search` is a getter that returns a *fresh*
 * object every access, so `vi.spyOn(redis.search, "createIndex")` would spy on a throwaway. We
 * snapshot the namespace once and feed it to the wrapper through a Proxy, so the wrapper and the spy
 * share the same `createIndex` (which still closes over the real client and hits real Redis).
 */

// A fuzzy text field, an exact-match (noTokenize) field for filtering, and a numeric field (numeric
// fields are FAST, so they're valid aggregation targets — a noTokenize string is not).
const Schema = s.object({
  title: s.string(),
  tenant: s.string().noTokenize(),
  views: s.number(),
});

// A concrete, always-valid filter that matches nothing here (so reads are genuinely empty/missing).
const FILTER = { tenant: { $eq: "nobody" } } as Parameters<
  ReactiveSearchIndex<typeof Schema>["count"]
>[0]["filter"];

// A stats aggregation over the numeric field.
const AGGS = { aggregations: { viewsStats: { $stats: { field: "views" } } } } as Parameters<
  ReactiveSearchIndex<typeof Schema>["aggregate"]
>[0];

// Index names must be identifier-safe (the real features sanitize the prefix the same way).
const idxName = (prefix: string) => prefix.replace(/[^a-zA-Z0-9_]/g, "_");

type CreateParams = Parameters<Redis["search"]["createIndex"]>[0];

describe.skipIf(!hasRedisCreds)("ReactiveSearchIndex (live Redis)", () => {
  const redis = testRedis();
  // The DB caps at 10 search indexes, so tear everything down after each test.
  const cleanups: Array<() => Promise<unknown>> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const teardown of cleanups.splice(0).reverse()) {
      await teardown().catch(() => {
        /* best-effort cleanup */
      });
    }
  });

  /** Fresh, unique index name + prefix, with drop + key cleanup registered. */
  function names(label: string) {
    const prefix = uniquePrefix(label);
    const name = idxName(prefix);
    cleanups.push(() => redis.search.index({ name, schema: Schema }).drop());
    cleanups.push(() => cleanupKeys(redis, prefix));
    return { prefix, name };
  }

  /** Create an existing-but-empty index (no documents) and wait until it's queryable. */
  async function seedEmptyIndex(prefix: string, name: string) {
    await redis.search.createIndex({
      name,
      dataType: "json",
      prefix: `${prefix}:`,
      schema: Schema,
      existsOk: true,
    } as CreateParams);
    await redis.search.index({ name, schema: Schema }).waitIndexing();
  }

  /**
   * Build a ReactiveSearchIndex whose `redis.search` is a single stable snapshot, and return a spy on
   * its `createIndex` (call-through). Call AFTER any setup `createIndex` so setup isn't counted.
   */
  function bind(prefix: string, name: string) {
    const search = redis.search; // snapshot once so the spy survives repeated `.search` access
    const createIndexSpy = vi.spyOn(search, "createIndex");
    const proxy = new Proxy(redis, {
      get: (target, prop) => (prop === "search" ? search : Reflect.get(target, prop)),
    }) as unknown as Redis;
    const ri = new ReactiveSearchIndex({
      redis: proxy,
      indexName: name,
      prefix: `${prefix}:`,
      schema: Schema,
    });
    return { ri, createIndexSpy };
  }

  // --- 1. Characterize the raw index: how does each op signal "no index" vs "no data"? -------------

  it("raw index signals a missing index per op (query→null, count→{count:-1}, aggregate→throws)", async () => {
    const { name } = names("raw-missing");
    const raw = redis.search.index({ name, schema: Schema });

    expect(await raw.query({ filter: FILTER })).toBeNull();
    expect(await raw.count({ filter: FILTER })).toEqual({ count: -1 });
    await expect(raw.aggregate(AGGS)).rejects.toThrow();
  });

  it("raw existing-but-empty index returns ordinary empties, NOT the missing sentinels", async () => {
    const { prefix, name } = names("raw-empty");
    await seedEmptyIndex(prefix, name);
    const raw = redis.search.index({ name, schema: Schema });

    // Distinct from the missing case: an array (not null), count 0 (not -1), and aggregate resolves.
    expect(await raw.query({ filter: FILTER })).toEqual([]);
    expect(await raw.count({ filter: FILTER })).toEqual({ count: 0 });
    await expect(raw.aggregate(AGGS)).resolves.toBeDefined();
  });

  // --- 2. Reactive wrapper: provision exactly once on a missing index, retrying the op -------------

  it("provisions once and retries the op on a missing index (query)", async () => {
    const { prefix, name } = names("reactive-query");
    const { ri, createIndexSpy } = bind(prefix, name);
    const querySpy = vi.spyOn(ri.index, "query");

    expect(await ri.query({ filter: FILTER })).toEqual([]); // empty after provisioning
    expect(createIndexSpy).toHaveBeenCalledTimes(1); // one create-index request
    expect(querySpy).toHaveBeenCalledTimes(2); // initial (null) + retry after provisioning
  });

  it("provisions once and retries the op on a missing index (count)", async () => {
    const { prefix, name } = names("reactive-count");
    const { ri, createIndexSpy } = bind(prefix, name);
    const countSpy = vi.spyOn(ri.index, "count");

    expect(await ri.count({ filter: FILTER })).toEqual({ count: 0 });
    expect(createIndexSpy).toHaveBeenCalledTimes(1);
    expect(countSpy).toHaveBeenCalledTimes(2);
  });

  it("provisions once and retries the op on a missing index (aggregate)", async () => {
    const { prefix, name } = names("reactive-agg");
    const { ri, createIndexSpy } = bind(prefix, name);
    const aggSpy = vi.spyOn(ri.index, "aggregate");

    await expect(ri.aggregate(AGGS)).resolves.toBeDefined();
    expect(createIndexSpy).toHaveBeenCalledTimes(1);
    expect(aggSpy).toHaveBeenCalledTimes(2);
  });

  // --- 3. Reactive wrapper: do NOT provision just because the data is missing ----------------------

  it("does NOT send a create-index request when the index exists but has no data", async () => {
    const { prefix, name } = names("reactive-empty");
    await seedEmptyIndex(prefix, name); // create the index BEFORE spying so setup isn't counted
    const { ri, createIndexSpy } = bind(prefix, name);
    const querySpy = vi.spyOn(ri.index, "query");
    const countSpy = vi.spyOn(ri.index, "count");
    const aggSpy = vi.spyOn(ri.index, "aggregate");

    expect(await ri.query({ filter: FILTER })).toEqual([]);
    expect(await ri.count({ filter: FILTER })).toEqual({ count: 0 });
    await expect(ri.aggregate(AGGS)).resolves.toBeDefined();

    // The crux: empty results are not the missing-index sentinels, so there is no re-provision...
    expect(createIndexSpy).not.toHaveBeenCalled();
    // ...and each op ran exactly once (no duplicate request from a spurious retry).
    expect(querySpy).toHaveBeenCalledTimes(1);
    expect(countSpy).toHaveBeenCalledTimes(1);
    expect(aggSpy).toHaveBeenCalledTimes(1);
  });

  // --- 4. Reactive wrapper: provisioning is memoized across reads on one instance ------------------

  it("provisions only once across repeated reads on the same instance", async () => {
    const { prefix, name } = names("reactive-memo");
    const { ri, createIndexSpy } = bind(prefix, name);

    await ri.query({ filter: FILTER }); // missing → provisions
    await ri.query({ filter: FILTER }); // now exists → no re-provision
    await ri.count({ filter: FILTER });

    expect(createIndexSpy).toHaveBeenCalledTimes(1);
  });
});
