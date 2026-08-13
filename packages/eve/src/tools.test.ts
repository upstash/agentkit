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

  it("rejects a streaming (async generator) execute at the type level", () => {
    // A cached tool cannot stream — a cache hit could never replay eve ≥0.31's preliminary
    // output snapshots — so `DefineCachedToolConfig.execute` only accepts resolving executors.
    defineCachedTool({
      description: "stream",
      inputSchema: z.object({ n: z.number() }),
      toolName: "stream",
      userId: ns,
      redis,
      // @ts-expect-error — async-generator executors are not cacheable
      async *execute({ n }: { n: number }) {
        yield n;
      },
    });
  });

  it("rejects a streaming execute at runtime (JS callers bypass the types)", async () => {
    const t = defineCachedTool({
      description: "stream",
      inputSchema: z.object({ n: z.number() }),
      toolName: "stream-runtime",
      userId: ns,
      redis,
      execute: async function* ({ n }: { n: number }) {
        yield n;
      } as never, // cast past the type-level rejection, like an untyped JS caller
    });

    // The generator must be refused before ToolCache serializes the generator object into Redis.
    await expect(Promise.resolve(t.execute({ n: 1 }, CTX))).rejects.toThrow(
      /streaming \(async generator\) executors cannot be cached/,
    );
  });
});
