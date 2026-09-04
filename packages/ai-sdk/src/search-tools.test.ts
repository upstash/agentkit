import { s } from "@upstash/redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSearchTools } from "./search-tools.js";
import { hasRedisCreds, testRedis, uniquePrefix } from "./test-support.js";

const TOOL_OPTS = { toolCallId: "t", messages: [] } as never;
function call<R>(execute: unknown, input: unknown): Promise<R> {
  return (execute as (i: unknown, o: unknown) => Promise<R>)(input, TOOL_OPTS);
}

/** Poll a read until it reflects a just-written doc — insurance for residual indexing lag. */
async function pollUntil<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8_000; // well inside vitest's 30s testTimeout
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

describe.skipIf(!hasRedisCreds)("createSearchTools (live Redis)", () => {
  const redis = testRedis();
  const name = uniquePrefix("searchtools").replace(/[^a-zA-Z0-9_]/g, "_");
  const prefix = `${name}:`;
  const tools = createSearchTools({ schema, redis, indexName: name, prefix });

  // Create the index BEFORE anything is seeded under its prefix. `waitIndexing()` on an index that
  // does not exist yet is a silent no-op, so seeding first and letting the first read provision it
  // reactively leaves the reads racing the backfill. Any read provisions: a missing index answers
  // `count` with the `{count: -1}` sentinel, which makes the tool create it and retry.
  beforeAll(async () => {
    await call<{ count: number }>(tools.count!.execute, { filter: { city: { $eq: "nowhere" } } });
  });

  afterAll(async () => {
    try {
      await redis.search.index({ name }).drop();
    } catch {
      /* may not exist */
    }
  });

  it("returns search / aggregate / count tools with schema-aware descriptions", () => {
    expect(Object.keys(tools).sort()).toEqual(["aggregate", "count", "search"]);
    // Descriptions teach the agent the fields + operators.
    expect(tools.search!.description).toContain("`name` (TEXT)");
    expect(tools.search!.description).toContain("`age` (F64)");
    expect(tools.search!.description).toContain("$smart");
    expect(tools.search!.inputSchema).toBeDefined();
  });

  it("search tool runs a $smart query against the index", async () => {
    // Seed documents under the index prefix (auto-synced into the index).
    await redis.json.set(`${prefix}1`, "$", { name: "Ada Lovelace", age: 36, city: "London" });
    await redis.json.set(`${prefix}2`, "$", { name: "Alan Turing", age: 41, city: "London" });
    await redis.search.index({ name }).waitIndexing();

    const hits = await pollUntil(
      () =>
        call<{ data?: { name?: string } }[]>(tools.search!.execute, {
          filter: { name: { $smart: "ada" } },
        }),
      (found) => found.some((h) => h.data?.name?.includes("Ada")),
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.data?.name?.includes("Ada"))).toBe(true);
  });

  it("count tool counts matching documents", async () => {
    // Counts the two docs seeded by the previous test; poll until indexing has caught up with both.
    const result = await pollUntil(
      () => call<{ count: number }>(tools.count!.execute, { filter: { city: { $eq: "London" } } }),
      (r) => r.count >= 2,
    );
    expect(result.count).toBeGreaterThanOrEqual(2);
  });
});
