import { Sandbox, ToolCache, ToolTimeoutError } from "@upstash/agentkit-sdk";
import { MemoryRedis } from "@upstash/agentkit-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { sandboxedTool, wrapTool } from "./tools.js";
import type { AiTool } from "./types.js";

describe("wrapTool", () => {
  it("throws when the tool has no execute", () => {
    expect(() => wrapTool("noop", {} as AiTool)).toThrow(/no `execute`/);
  });

  it("caches results so the underlying execute runs once per distinct args", async () => {
    const execute = vi.fn(async (args: { x: number }) => args.x * 2);
    const tool: AiTool<{ x: number }, number> = { description: "double", execute };
    const toolCache = new ToolCache({ redis: new MemoryRedis() });

    const wrapped = wrapTool("double", tool, { toolCache });
    const opts = { abortSignal: new AbortController().signal };

    expect(await wrapped.execute?.({ x: 21 }, opts)).toBe(42);
    expect(await wrapped.execute?.({ x: 21 }, opts)).toBe(42); // cache hit
    expect(execute).toHaveBeenCalledTimes(1);

    expect(await wrapped.execute?.({ x: 5 }, opts)).toBe(10); // different args -> miss
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("runs through a sandbox and returns the value", async () => {
    const tool: AiTool<{ n: number }, number> = {
      execute: async (args) => args.n + 1,
    };
    const sandbox = new Sandbox();
    const wrapped = sandboxedTool("inc", tool, sandbox);
    expect(await wrapped.execute?.({ n: 1 }, {})).toBe(2);
  });

  it("surfaces a sandbox timeout as a thrown ToolTimeoutError", async () => {
    const tool: AiTool<unknown, string> = {
      execute: (_args, options) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve("late"), 1000);
          options.abortSignal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        }),
    };
    const sandbox = new Sandbox({ timeoutMs: 10 });
    const wrapped = sandboxedTool("slow", tool, sandbox);
    await expect(wrapped.execute?.({}, {})).rejects.toBeInstanceOf(ToolTimeoutError);
  });

  it("retries through the sandbox until success", async () => {
    let attempts = 0;
    const tool: AiTool<unknown, string> = {
      execute: async () => {
        attempts++;
        if (attempts < 3) throw new Error("flaky");
        return "ok";
      },
    };
    const sandbox = new Sandbox({ maxRetries: 3, retryDelayMs: 1 });
    const wrapped = sandboxedTool("flaky", tool, sandbox);
    expect(await wrapped.execute?.({}, {})).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("preserves the AI tool shape (description + inputSchema)", () => {
    const tool: AiTool<unknown, string> = {
      description: "d",
      inputSchema: { type: "object" },
      execute: async () => "x",
    };
    const wrapped = wrapTool("t", tool, { toolCache: new ToolCache({ redis: new MemoryRedis() }) });
    expect(wrapped.description).toBe("d");
    expect(wrapped.inputSchema).toEqual({ type: "object" });
  });
});
