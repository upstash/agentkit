import { s } from "@upstash/redis";
import { afterAll, describe, expect, it } from "vitest";
import { defineSearchTools } from "./search-tools.js";
import { hasRedisCreds, testRedis, uniquePrefix } from "./test-support.js";

const CTX = {} as never;
function call<R>(execute: unknown, input: unknown): Promise<R> {
  return (execute as (i: unknown, c: unknown) => Promise<R>)(input, CTX);
}

/**
 * Re-run `read` until `ready` holds (or the deadline passes) and return the last value, so a caller
 * asserting on search results doesn't race Upstash's asynchronous indexing. On a genuine breakage
 * the predicate never holds and the caller's own `expect` still reports the original failure.
 */
async function pollUntil<R>(read: () => Promise<R>, ready: (value: R) => boolean): Promise<R> {
  const deadline = Date.now() + 8_000; // two polled reads still sit inside vitest's 30s testTimeout
  let value = await read();
  while (!ready(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    value = await read();
  }
  return value;
}

const schema = s.object({
  name: s.string(),
  age: s.number(),
  city: s.string().noTokenize(),
});

describe.skipIf(!hasRedisCreds)("defineSearchTools (live Redis)", () => {
  const redis = testRedis();
  const name = uniquePrefix("eve-search").replace(/[^a-zA-Z0-9_]/g, "_");
  const prefix = `${name}:`;
  const tools = defineSearchTools({ schema, redis, indexName: name, prefix });

  afterAll(async () => {
    await redis.search
      .index({ name })
      .drop()
      .catch(() => {});
  });

  it("returns search / aggregate / count tools with schema-aware descriptions", () => {
    expect(Object.keys(tools).sort()).toEqual(["aggregate", "count", "search"]);
    expect(tools.search.description).toContain("`name` (TEXT)");
    expect(tools.search.description).toContain("$smart");
    expect(tools.search.inputSchema).toBeDefined();
  });

  it("search runs a $smart query, creating the index reactively", async () => {
    // This first call is the reactive create (the index does not exist yet) — the behaviour this
    // test is named for. It has to happen BEFORE the writes: a doc written while the index is still
    // missing can be dropped by the create-time backfill *permanently*, not just late, so seeding
    // first and letting the read provision made this assertion flaky. Writes into an index that
    // already exists are indexed incrementally.
    await call<{ count: number }>(tools.count.execute, { filter: { city: { $eq: "nowhere" } } });

    await redis.json.set(`${prefix}1`, "$", { name: "Ada Lovelace", age: 36, city: "London" });
    await redis.json.set(`${prefix}2`, "$", { name: "Alan Turing", age: 41, city: "London" });

    // ...and the seeded docs only become visible once indexing is flushed. Verified against live
    // Redis: provisioning first *or* waiting alone leaves both reads at 0 indefinitely; only the
    // pair makes them land. The poll below is the belt-and-braces for residual lag.
    await redis.search.index({ name, schema }).waitIndexing();

    // Both reads poll until the index has caught up with the two writes above; the assertions
    // themselves are unchanged.
    const hits = await pollUntil(
      () =>
        call<{ data?: { name?: string } }[]>(tools.search.execute, {
          filter: { name: { $smart: "ada" } },
        }),
      (found) => found.some((h) => h.data?.name?.includes("Ada")),
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.data?.name?.includes("Ada"))).toBe(true);

    const result = await pollUntil(
      () =>
        call<{ count: number }>(tools.count.execute, {
          filter: { city: { $eq: "London" } },
        }),
      (counted) => counted.count >= 2,
    );
    expect(result.count).toBeGreaterThanOrEqual(2);
  });
});
