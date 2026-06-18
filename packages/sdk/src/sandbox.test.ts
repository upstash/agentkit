import { describe, expect, it, vi } from "vitest";
import { Sandbox, ToolTimeoutError } from "./sandbox.js";
import { Telemetry } from "./telemetry.js";
import { ToolCache } from "./tool-cache.js";
import { MemoryRedis } from "./testing/memory-redis.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Sandbox", () => {
  it("runs a registered tool successfully", async () => {
    const sandbox = new Sandbox();
    sandbox.register<{ n: number }, number>({
      name: "double",
      execute: async ({ n }) => n * 2,
    });

    const result = await sandbox.run<number>("double", { n: 21 });
    expect(result.ok).toBe(true);
    expect(result.value).toBe(42);
    expect(result.attempts).toBe(1);
    expect(result.cached).toBe(false);
  });

  it("returns a structured error for an unknown tool", async () => {
    const sandbox = new Sandbox();
    const result = await sandbox.run("nope", {});
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/Unknown tool/);
  });

  it("execute() throws on failure", async () => {
    const sandbox = new Sandbox();
    sandbox.register({
      name: "fail",
      execute: async () => {
        throw new Error("nope");
      },
    });
    await expect(sandbox.execute("fail", {})).rejects.toThrow("nope");
  });

  it("times out a slow tool", async () => {
    const sandbox = new Sandbox({ timeoutMs: 20 });
    sandbox.register({
      name: "slow",
      execute: async (_args, ctx) => {
        await sleep(200);
        return ctx.signal.aborted ? "aborted" : "done";
      },
    });
    const result = await sandbox.run("slow", {});
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(ToolTimeoutError);
  });

  it("retries failures up to maxRetries", async () => {
    const sandbox = new Sandbox({ maxRetries: 2, retryDelayMs: 1 });
    let calls = 0;
    sandbox.register({
      name: "flaky",
      execute: async () => {
        calls++;
        if (calls < 3) throw new Error("transient");
        return "ok";
      },
    });
    const result = await sandbox.run<string>("flaky", {});
    expect(result.ok).toBe(true);
    expect(result.value).toBe("ok");
    expect(result.attempts).toBe(3);
  });

  it("serves cached results without re-executing", async () => {
    const redis = new MemoryRedis();
    const toolCache = new ToolCache({ redis });
    const sandbox = new Sandbox({ toolCache });
    const execute = vi.fn(async ({ n }: { n: number }) => n + 1);
    sandbox.register({ name: "inc", execute });

    const first = await sandbox.run<number>("inc", { n: 1 });
    const second = await sandbox.run<number>("inc", { n: 1 });
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.value).toBe(2);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("records a telemetry span per execution", async () => {
    const redis = new MemoryRedis();
    const telemetry = new Telemetry({ redis });
    const sandbox = new Sandbox({ telemetry });
    sandbox.register({ name: "noop", execute: async () => "x" });

    await sandbox.run("noop", {}, { traceId: "trace-x" });
    const trace = await telemetry.getTrace("trace-x");
    expect(trace).toHaveLength(1);
    expect(trace[0]!.type).toBe("tool");
    expect(trace[0]!.attributes.tool).toBe("noop");
  });
});
