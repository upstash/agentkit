import { z } from "zod";
import { afterAll, describe, expect, it, vi } from "vitest";
import { defineCachedTool } from "./tools.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueUserId } from "./test-support.js";

const CTX = {} as never;

describe.skipIf(!hasRedisCreds)("defineCachedTool (live Redis)", () => {
  const redis = testRedis();
  // The tool owns its ToolCache (default `agentkit:toolCache` base); isolate this run by userId.
  const ns = uniqueUserId("eve-tool");

  afterAll(async () => {
    await cleanupKeys(redis, `agentkit:toolCache:${ns}`);
  });

  it("memoizes by userId + toolName + input so execute runs once", async () => {
    const fn = vi.fn(async ({ x }: { x: number }) => x * 2);
    const t = defineCachedTool({
      description: "double",
      inputSchema: z.object({ x: z.number() }),
      toolName: "double",
      userId: ns,
      execute: fn,
      redis,
    });

    expect(await t.execute({ x: 21 }, CTX)).toBe(42);
    expect(await t.execute({ x: 21 }, CTX)).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("supports a function userId (derived from input/ctx)", async () => {
    const fn = vi.fn(async ({ id }: { id: string }) => id.toUpperCase());
    const t = defineCachedTool({
      description: "upper",
      inputSchema: z.object({ id: z.string() }),
      toolName: "upper",
      userId: ({ id }) => `${ns}-${id}`,
      execute: fn,
      redis,
    });

    await t.execute({ id: "a" }, CTX);
    await t.execute({ id: "a" }, CTX);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // eve ≥0.31 lets `execute` be an async generator that streams preliminary output snapshots.
  // A cached tool drains it: only the final snapshot is returned and cached (`finalSnapshot`).
  describe("streaming (async generator) execute", () => {
    it("resolves to the final snapshot, not an intermediate one", async () => {
      const t = defineCachedTool({
        description: "stream",
        inputSchema: z.object({ n: z.number() }),
        toolName: "stream-final",
        userId: ns,
        redis,
        async *execute({ n }: { n: number }) {
          yield { progress: "partial", value: n };
          yield { progress: "partial", value: n * 10 };
          yield { progress: "done", value: n * 100 };
        },
      });

      expect(await t.execute({ n: 3 }, CTX)).toEqual({ progress: "done", value: 300 });
    });

    it("caches the drained snapshot so the generator runs once", async () => {
      const runs = vi.fn();
      const t = defineCachedTool({
        description: "stream",
        inputSchema: z.object({ n: z.number() }),
        toolName: "stream-cached",
        userId: ns,
        redis,
        async *execute({ n }: { n: number }) {
          runs();
          yield n;
          yield n * 2;
        },
      });

      expect(await t.execute({ n: 21 }, CTX)).toBe(42);
      expect(await t.execute({ n: 21 }, CTX)).toBe(42);
      expect(runs).toHaveBeenCalledTimes(1);
    });

    it("rejects when the generator yields nothing, without caching the failure", async () => {
      let broken = true;
      const runs = vi.fn();
      const t = defineCachedTool({
        description: "stream",
        inputSchema: z.object({}),
        toolName: "stream-empty",
        userId: ns,
        redis,
        async *execute() {
          runs();
          if (!broken) yield "ok";
        },
      });

      await expect(t.execute({}, CTX)).rejects.toThrow(/without yielding a result/);

      // The failed call must not have poisoned the cache: once the tool yields, its
      // result comes from a fresh run (2 executions total), then caches normally.
      broken = false;
      expect(await t.execute({}, CTX)).toBe("ok");
      expect(await t.execute({}, CTX)).toBe("ok");
      expect(runs).toHaveBeenCalledTimes(2);
    });
  });
});
