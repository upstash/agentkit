import { s } from "@upstash/redis";
import { afterAll, describe, expect, it } from "vitest";
import { defineSearchTools } from "./search-tools.js";
import { hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

const CTX = {} as never;
function call<R>(execute: unknown, input: unknown): Promise<R> {
  return (execute as (i: unknown, c: unknown) => Promise<R>)(input, CTX);
}

const schema = s.object({
  name: s.string(),
  age: s.number(),
  city: s.string().noTokenize(),
});

describe.skipIf(!hasRedisCreds)("defineSearchTools (live Redis)", () => {
  const redis = testRedis();
  const name = uniqueNamespace("eve-search").replace(/[^a-zA-Z0-9_]/g, "_");
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
    await redis.json.set(`${prefix}1`, "$", { name: "Ada Lovelace", age: 36, city: "London" });
    await redis.json.set(`${prefix}2`, "$", { name: "Alan Turing", age: 41, city: "London" });

    const hits = await call<{ data?: { name?: string } }[]>(tools.search.execute, {
      filter: { name: { $smart: "ada" } },
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.data?.name?.includes("Ada"))).toBe(true);

    const result = await call<{ count: number }>(tools.count.execute, {
      filter: { city: { $eq: "London" } },
    });
    expect(result.count).toBeGreaterThanOrEqual(2);
  });
});
