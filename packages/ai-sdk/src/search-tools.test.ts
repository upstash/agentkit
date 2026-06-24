import { s } from "@upstash/redis";
import { afterAll, describe, expect, it } from "vitest";
import { createSearchTools } from "./search-tools.js";
import { hasRedisCreds, testRedis, uniquePrefix } from "./test-support.js";

const TOOL_OPTS = { toolCallId: "t", messages: [] } as never;
function call<R>(execute: unknown, input: unknown): Promise<R> {
  return (execute as (i: unknown, o: unknown) => Promise<R>)(input, TOOL_OPTS);
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

    const hits = await call<{ data?: { name?: string } }[]>(tools.search!.execute, {
      filter: { name: { $smart: "ada" } },
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.data?.name?.includes("Ada"))).toBe(true);
  });

  it("count tool counts matching documents", async () => {
    const result = await call<{ count: number }>(tools.count!.execute, {
      filter: { city: { $eq: "London" } },
    });
    expect(result.count).toBeGreaterThanOrEqual(2);
  });
});
