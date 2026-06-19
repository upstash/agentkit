import { Telemetry } from "@upstash/agentkit-sdk";
import { MemoryRedis } from "@upstash/agentkit-sdk/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { traceRun } from "./telemetry.js";

describe("traceRun", () => {
  let telemetry: Telemetry;
  let clock: number;

  beforeEach(() => {
    clock = 0;
    telemetry = new Telemetry({ redis: new MemoryRedis(), clock: () => (clock += 10) });
  });

  it("records a run span and returns the function's value", async () => {
    const traceId = "trace-1";
    const result = await traceRun({ telemetry, traceId }, "eve-run", async (span) => {
      span.setAttribute("model", "claude-opus");
      return "done";
    });
    expect(result).toBe("done");

    const spans = await telemetry.getTrace(traceId);
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span?.name).toBe("eve-run");
    expect(span?.type).toBe("run");
    expect(span?.status).toBe("ok");
    expect(span?.attributes.model).toBe("claude-opus");
  });

  it("honors a custom span type and up-front attributes", async () => {
    const traceId = "trace-2";
    await traceRun(
      { telemetry, traceId, type: "model", attributes: { provider: "eve" } },
      "gen",
      async () => "x",
    );
    const [span] = await telemetry.getTrace(traceId);
    expect(span?.type).toBe("model");
    expect(span?.attributes.provider).toBe("eve");
  });

  it("records an error span and rethrows", async () => {
    const traceId = "trace-3";
    await expect(
      traceRun({ telemetry, traceId }, "boom", async () => {
        throw new Error("run failed");
      }),
    ).rejects.toThrow("run failed");
    const [span] = await telemetry.getTrace(traceId);
    expect(span?.status).toBe("error");
    expect(span?.error).toBe("run failed");
  });
});
