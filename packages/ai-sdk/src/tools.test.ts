import { ToolCache } from "@upstash/agentkit-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";
import { wrapTool } from "./tools.js";
import type { AiTool } from "./types.js";

describe.skipIf(!hasRedisCreds)("wrapTool", () => {
  const redis = testRedis();
  const namespace = uniqueNamespace("tools");
  let toolCache: ToolCache;

  beforeAll(() => {
    toolCache = new ToolCache({ redis, namespace });
  });

  afterAll(async () => {
    await cleanupKeys(redis, namespace);
  });

  it("throws when the tool has no execute", () => {
    expect(() => wrapTool("noop", {} as AiTool)).toThrow(/no `execute`/);
  });

  it("caches results so the underlying execute runs once per distinct args", async () => {
    const execute = vi.fn(async (args: { x: number }) => args.x * 2);
    const tool: AiTool<{ x: number }, number> = { description: "double", execute };

    const wrapped = wrapTool("double", tool, { toolCache });
    const opts = { abortSignal: new AbortController().signal };

    expect(await wrapped.execute?.({ x: 21 }, opts)).toBe(42);
    expect(await wrapped.execute?.({ x: 21 }, opts)).toBe(42); // cache hit
    expect(execute).toHaveBeenCalledTimes(1);

    expect(await wrapped.execute?.({ x: 5 }, opts)).toBe(10); // different args -> miss
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("runs the original execute directly when no cache is given", async () => {
    const tool: AiTool<{ n: number }, number> = {
      execute: async (args) => args.n + 1,
    };
    const wrapped = wrapTool("inc", tool);
    expect(await wrapped.execute?.({ n: 1 }, {})).toBe(2);
  });

  it("preserves the AI tool shape (description + inputSchema)", () => {
    const tool: AiTool<unknown, string> = {
      description: "d",
      inputSchema: { type: "object" },
      execute: async () => "x",
    };
    const wrapped = wrapTool("t", tool, { toolCache });
    expect(wrapped.description).toBe("d");
    expect(wrapped.inputSchema).toEqual({ type: "object" });
  });
});
