import { beforeEach, describe, expect, it } from "vitest";
import { Telemetry } from "./telemetry.js";
import { MemoryRedis } from "./testing/memory-redis.js";

describe("Telemetry", () => {
  let redis: MemoryRedis;
  let t: number;
  let telemetry: Telemetry;

  beforeEach(() => {
    redis = new MemoryRedis();
    t = 1000;
    telemetry = new Telemetry({ redis, clock: () => t });
  });

  it("records a span with computed duration", async () => {
    const span = telemetry.startSpan("model-call", { type: "model", traceId: "trace-1" });
    span.setAttribute("tokens", 42);
    t = 1500;
    await span.end({ status: "ok" });

    const trace = await telemetry.getTrace("trace-1");
    expect(trace).toHaveLength(1);
    expect(trace[0]!.durationMs).toBe(500);
    expect(trace[0]!.attributes.tokens).toBe(42);
    expect(trace[0]!.status).toBe("ok");
  });

  it("orders spans within a trace chronologically", async () => {
    const a = telemetry.startSpan("a", { traceId: "tr" });
    await a.end();
    t = 2000;
    const b = telemetry.startSpan("b", { traceId: "tr" });
    await b.end();

    const trace = await telemetry.getTrace("tr");
    expect(trace.map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("trace() records success and returns the value", async () => {
    const result = await telemetry.trace(
      "run",
      async (span) => {
        span.setAttribute("ok", true);
        return 123;
      },
      { traceId: "tr2", type: "run" },
    );
    expect(result).toBe(123);
    const [span] = await telemetry.getTrace("tr2");
    expect(span!.status).toBe("ok");
    expect(span!.attributes.ok).toBe(true);
  });

  it("trace() captures thrown errors and rethrows", async () => {
    await expect(
      telemetry.trace(
        "boom",
        async () => {
          throw new Error("kaboom");
        },
        { traceId: "tr3" },
      ),
    ).rejects.toThrow("kaboom");

    const [span] = await telemetry.getTrace("tr3");
    expect(span!.status).toBe("error");
    expect(span!.error).toBe("kaboom");
  });

  it("end() is idempotent", async () => {
    const span = telemetry.startSpan("once", { traceId: "tr4" });
    await span.end();
    await span.end();
    const trace = await telemetry.getTrace("tr4");
    expect(trace).toHaveLength(1);
  });
});
