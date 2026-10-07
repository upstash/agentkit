import { s } from "@upstash/redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chat } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { createSearchTools } from "./search-tools.js";
import { scriptedAdapter } from "../testing/test-adapter.js";
import { hasRedisCreds, testRedis, uniquePrefix } from "../testing/test-support.js";

async function drain(stream: unknown): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of stream as AsyncIterable<StreamChunk>) out.push(c);
  return out;
}

const schema = s.object({ name: s.string(), price: s.number(), category: s.string().noTokenize() });

describe.skipIf(!hasRedisCreds)("createSearchTools (live Redis, real chat loop)", () => {
  const redis = testRedis();
  const name = uniquePrefix("tssearch").replace(/[^a-zA-Z0-9_]/g, "_");
  const prefix = `${name}:`;
  const tools = createSearchTools({ schema, redis, indexName: name, prefix });
  const byName = Object.fromEntries(tools.map((t) => [(t as { name: string }).name, t]));

  beforeAll(async () => {
    // Provision before seeding, then seed and wait (provision -> write -> waitIndexing -> read).
    await (byName.count as unknown as { execute: (i: unknown) => Promise<unknown> }).execute({
      filter: { category: { $eq: "none" } },
    });
    await redis.json.set(`${prefix}1`, "$", {
      name: "Wireless headphones",
      price: 99,
      category: "audio",
    });
    await redis.json.set(`${prefix}2`, "$", { name: "Desk lamp", price: 25, category: "home" });
    await redis.search.index({ name }).waitIndexing();
  });

  afterAll(async () => {
    try {
      await redis.search.index({ name }).drop();
    } catch {
      /* may not exist */
    }
    await redis.del(`${prefix}1`, `${prefix}2`);
  });

  it("exposes search / aggregate / count with schema-aware descriptions", () => {
    expect(Object.keys(byName).sort()).toEqual(["aggregate", "count", "search"]);
    expect((byName.search as { description: string }).description).toContain("`price` (F64)");
  });

  it("the model's search call runs a typo-tolerant query and the result reaches the next turn", async () => {
    const adapter = scriptedAdapter([
      {
        toolCalls: [
          { id: "q1", name: "search", args: { filter: { name: { $smart: "hedphones" } } } },
        ],
      },
      { text: "Found them." },
    ]);
    await drain(
      chat({
        adapter: adapter as never,
        messages: [{ role: "user", content: "headphones?" }],
        tools,
      }),
    );
    const toolMsg = (adapter.calls[1]!.messages as { role: string; content: string }[]).find(
      (m) => m.role === "tool",
    );
    expect(toolMsg!.content).toContain("Wireless headphones");
    expect(toolMsg!.content).not.toContain("Desk lamp");
  });
});
