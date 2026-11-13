import { afterAll, describe, expect, it } from "vitest";
import type { MCPEventSubscription } from "@tanstack/ai-mcp/events";
import { upstashMcpEventStore } from "./event-store.js";
import { upstashMcpTaskStore } from "./task-store.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniquePrefix } from "../testing/test-support.js";

const subscription = (key: string, id?: string): MCPEventSubscription => ({
  key,
  ...(id === undefined ? {} : { id }),
  name: "issues.opened",
  arguments: { repo: "upstash/agentkit", labels: [] },
  definition: { name: "issues.opened" } as MCPEventSubscription["definition"],
  delivery: { mode: "webhook", url: "https://example.com/hook", secret: "s3cr3t" },
  refreshBefore: null,
  cursor: null,
  truncated: false,
  status: "pending",
});

// No upstream testkit exists for these contracts; the cases mirror `inMemoryMCPEventStore()` and
// `inMemoryTaskStore()` from `@tanstack/ai-mcp`.
describe.skipIf(!hasRedisCreds)("MCP stores (live Redis)", () => {
  const redis = testRedis();
  const prefix = uniquePrefix("tmcp");
  let n = 0;
  const next = () => `${prefix}:${++n}`;

  afterAll(async () => {
    await cleanupKeys(redis, prefix);
  });

  describe("upstashMcpTaskStore", () => {
    it("round-trips values, returns null when missing, and deletes", async () => {
      const tasks = upstashMcpTaskStore({ redis, prefix: next() });
      expect(await tasks.get("t1")).toBeNull();
      const record = {
        taskId: "t1",
        status: "working",
        ttl: null,
        createdAt: "2026-11-11T00:00:00Z",
      };
      await tasks.set("t1", record);
      expect(await tasks.get("t1")).toEqual(record);
      await tasks.set("t1", { ...record, status: "completed" });
      expect(await tasks.get("t1")).toMatchObject({ status: "completed" });
      await tasks.delete("t1");
      expect(await tasks.get("t1")).toBeNull();
    });

    it("keeps primitive values as they were", async () => {
      const tasks = upstashMcpTaskStore({ redis, prefix: next() });
      await tasks.set("s", "123");
      await tasks.set("n", 123);
      expect(await tasks.get("s")).toBe("123");
      expect(await tasks.get("n")).toBe(123);
    });

    it("expires records with ttlSeconds", async () => {
      const p = next();
      const tasks = upstashMcpTaskStore({ redis, prefix: p, ttlSeconds: 60 });
      await tasks.set("t", { status: "working" });
      const ttl = await redis.ttl(`${p}:mcp:task:t`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);
    });
  });

  describe("upstashMcpEventStore", () => {
    it("gets by key and by id, and returns undefined when missing", async () => {
      const store = upstashMcpEventStore({ redis, prefix: next() });
      expect(await store.get("k1")).toBeUndefined();
      expect(await store.getById("id1")).toBeUndefined();
      await store.set(subscription("k1", "id1"));
      expect(await store.get("k1")).toEqual(subscription("k1", "id1"));
      expect(await store.getById("id1")).toEqual(subscription("k1", "id1"));
    });

    it("re-indexes when set replaces a subscription with another id", async () => {
      const store = upstashMcpEventStore({ redis, prefix: next() });
      await store.set(subscription("k1", "old"));
      await store.set(subscription("k1", "new"));
      expect(await store.getById("old")).toBeUndefined();
      expect(await store.getById("new")).toMatchObject({ key: "k1" });
      await store.set(subscription("k1"));
      expect(await store.getById("new")).toBeUndefined();
    });

    it("update merges fields, assigns an id, ignores a missing key", async () => {
      const store = upstashMcpEventStore({ redis, prefix: next() });
      await store.update("missing", { cursor: "c" });
      expect(await store.get("missing")).toBeUndefined();

      await store.set(subscription("k1"));
      await store.update("k1", { id: "id1", status: "active", cursor: "c1" });
      expect(await store.get("k1")).toEqual({
        ...subscription("k1", "id1"),
        status: "active",
        cursor: "c1",
      });
      expect(await store.getById("id1")).toMatchObject({ cursor: "c1" });

      await store.update("k1", { id: "id2" });
      expect(await store.getById("id1")).toBeUndefined();
      expect(await store.getById("id2")).toMatchObject({ key: "k1", cursor: "c1" });
    });

    it("keeps every field when updates race", async () => {
      const store = upstashMcpEventStore({ redis, prefix: next() });
      await store.set(subscription("k1", "id1"));
      await Promise.all([
        store.update("k1", { cursor: "c9" }),
        store.update("k1", { refreshBefore: "2026-12-01T00:00:00Z" }),
        store.update("k1", { status: "active" }),
        store.update("k1", { truncated: true }),
      ]);
      expect(await store.get("k1")).toMatchObject({
        cursor: "c9",
        refreshBefore: "2026-12-01T00:00:00Z",
        status: "active",
        truncated: true,
      });
    });

    it("deletes and lists, with numeric-looking keys and ids intact", async () => {
      const store = upstashMcpEventStore({ redis, prefix: next() });
      await store.set(subscription("007", "42"));
      await store.set(subscription("k2", "id2"));
      expect(await store.getById("42")).toMatchObject({ key: "007" });
      const keys: string[] = [];
      for await (const s of store.list!()) keys.push(s.key);
      expect(keys.sort()).toEqual(["007", "k2"]);

      await store.delete("007");
      expect(await store.get("007")).toBeUndefined();
      expect(await store.getById("42")).toBeUndefined();
      const after: string[] = [];
      for await (const s of store.list!()) after.push(s.key);
      expect(after).toEqual(["k2"]);
    });
  });
});
