import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Telemetry } from "./telemetry.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

describe.skipIf(!hasRedisCreds)("Telemetry (live Redis)", () => {
  const redis = testRedis();
  const namespace = uniqueNamespace("telemetry");
  let t = 1000;
  let telemetry: Telemetry;

  beforeEach(() => {
    t = 1000;
    // Real Redis for storage; an injected clock keeps durations deterministic.
    telemetry = new Telemetry({ redis, namespace, clock: () => t });
  });

  afterAll(async () => {
    await cleanupKeys(redis, namespace);
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
    const a = telemetry.startSpan("a", { traceId: "tr-order" });
    await a.end();
    t = 2000;
    const b = telemetry.startSpan("b", { traceId: "tr-order" });
    await b.end();

    const trace = await telemetry.getTrace("tr-order");
    expect(trace.map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("trace() records success and returns the value", async () => {
    const result = await telemetry.trace(
      "run",
      async (span) => {
        span.setAttribute("ok", true);
        return 123;
      },
      { traceId: "tr-ok", type: "run" },
    );
    expect(result).toBe(123);
    const [span] = await telemetry.getTrace("tr-ok");
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
        { traceId: "tr-err" },
      ),
    ).rejects.toThrow("kaboom");

    const [span] = await telemetry.getTrace("tr-err");
    expect(span!.status).toBe("error");
    expect(span!.error).toBe("kaboom");
  });

  it("end() is idempotent", async () => {
    const span = telemetry.startSpan("once", { traceId: "tr-idem" });
    await span.end();
    await span.end();
    expect(await telemetry.getTrace("tr-idem")).toHaveLength(1);
  });
});
