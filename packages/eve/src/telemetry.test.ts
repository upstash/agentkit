import { Telemetry } from "@upstash/agentkit-sdk";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { traceRun } from "./telemetry.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueNamespace } from "./test-support.js";

describe.skipIf(!hasRedisCreds)("traceRun (live Redis)", () => {
  const redis = testRedis();
  const namespace = uniqueNamespace("eve-tel");
  let clock: number;
  let telemetry: Telemetry;

  beforeEach(() => {
    clock = 0;
    telemetry = new Telemetry({ redis, namespace, clock: () => (clock += 10) });
  });

  afterAll(async () => {
    await cleanupKeys(redis, namespace);
  });

  it("records a run span and returns the function's value", async () => {
    const traceId = "trace-1";
    const result = await traceRun({ telemetry, traceId }, "eve-run", async (span) => {
      span.setAttribute("model", "claude-opus");
      return "done";
    });
    expect(result).toBe("done");

    const [span] = await telemetry.getTrace(traceId);
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
