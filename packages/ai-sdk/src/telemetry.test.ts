import { Telemetry } from "@upstash/agentkit-sdk";
import { MemoryRedis } from "@upstash/agentkit-sdk/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { tracedGeneration } from "./telemetry.js";

describe("tracedGeneration", () => {
  let telemetry: Telemetry;
  let clock: number;

  beforeEach(() => {
    clock = 0;
    telemetry = new Telemetry({ redis: new MemoryRedis(), clock: () => (clock += 10) });
  });

  it("records a model span with model id and token usage", async () => {
    const traceId = "trace-1";
    const result = await tracedGeneration(
      async () => ({
        text: "hi",
        usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
      }),
      { telemetry, model: "gpt-4o", traceId },
    );
    expect(result.text).toBe("hi");

    const spans = await telemetry.getTrace(traceId);
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span?.type).toBe("model");
    expect(span?.status).toBe("ok");
    expect(span?.attributes.model).toBe("gpt-4o");
    expect(span?.attributes.promptTokens).toBe(7);
    expect(span?.attributes.completionTokens).toBe(3);
    expect(span?.attributes.totalTokens).toBe(10);
  });

  it("normalizes v5 input/output token field names", async () => {
    const traceId = "trace-2";
    await tracedGeneration(
      async () => ({ text: "x", usage: { inputTokens: 4, outputTokens: 2 } }),
      {
        telemetry,
        traceId,
      },
    );
    const [span] = await telemetry.getTrace(traceId);
    expect(span?.attributes.promptTokens).toBe(4);
    expect(span?.attributes.completionTokens).toBe(2);
  });

  it("records an error span and rethrows", async () => {
    const traceId = "trace-3";
    await expect(
      tracedGeneration(
        async () => {
          throw new Error("model failed");
        },
        { telemetry, traceId },
      ),
    ).rejects.toThrow("model failed");
    const [span] = await telemetry.getTrace(traceId);
    expect(span?.status).toBe("error");
    expect(span?.error).toBe("model failed");
  });
});
