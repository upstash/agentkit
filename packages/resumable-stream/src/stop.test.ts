import { describe, expect, it, vi } from "vitest";
import { createStopSignal, requestStop, StopRequestedError } from "./stop.js";
import { MemoryRedisServer } from "./testing/memory-redis.js";
import { pollUntil, tick } from "./test-support.js";

const setup = () => {
  const server = new MemoryRedisServer();
  return { server, redis: server.client(), enableTelemetry: false };
};

describe("requestStop / createStopSignal", () => {
  it("aborts once a stop is requested, with a StopRequestedError", async () => {
    const { redis } = setup();
    const stop = createStopSignal("s1", { redis, pollIntervalMs: 10, enableTelemetry: false });
    await tick(40);
    expect(stop.signal.aborted).toBe(false);
    await requestStop("s1", { redis, enableTelemetry: false });
    expect(await pollUntil(() => stop.signal.aborted, 1000, 5)).toBe(true);
    expect(stop.signal.reason).toBeInstanceOf(StopRequestedError);
    expect((stop.signal.reason as StopRequestedError).streamId).toBe("s1");
  });

  it("sees a stop requested before the producer started", async () => {
    const { redis } = setup();
    await requestStop("s1", { redis, enableTelemetry: false });
    const stop = createStopSignal("s1", { redis, pollIntervalMs: 10_000, enableTelemetry: false });
    expect(await pollUntil(() => stop.signal.aborted, 1000, 5)).toBe(true);
  });

  it("only stops its own stream", async () => {
    const { redis } = setup();
    const stop = createStopSignal("s1", { redis, pollIntervalMs: 10, enableTelemetry: false });
    await requestStop("s2", { redis, enableTelemetry: false });
    await tick(50);
    expect(stop.signal.aborted).toBe(false);
    stop.dispose();
  });

  it("dispose stops polling", async () => {
    const { server, redis } = setup();
    const stop = createStopSignal("s1", { redis, pollIntervalMs: 5, enableTelemetry: false });
    await tick(30);
    stop.dispose();
    stop.dispose();
    await tick(10);
    const count = server.requests.length;
    await tick(50);
    expect(server.requests.length).toBe(count);
  });

  it("follows a parent signal", () => {
    const { redis } = setup();
    const parent = new AbortController();
    const stop = createStopSignal("s1", { redis, signal: parent.signal, enableTelemetry: false });
    parent.abort("client gone");
    expect(stop.signal.aborted).toBe(true);
    expect(stop.signal.reason).toBe("client gone");
  });

  it("keeps polling through a failed check", async () => {
    const { server, redis } = setup();
    const onError = vi.fn();
    server.failNext = 1;
    const stop = createStopSignal("s1", {
      redis,
      pollIntervalMs: 5,
      onError,
      enableTelemetry: false,
    });
    await requestStop("s1", { redis, enableTelemetry: false }).catch(() => undefined);
    await requestStop("s1", { redis, enableTelemetry: false });
    expect(await pollUntil(() => stop.signal.aborted, 1000, 5)).toBe(true);
    expect(onError).toHaveBeenCalled();
  });

  it("validates its arguments", () => {
    const { redis } = setup();
    expect(() => createStopSignal("", { redis })).toThrow(TypeError);
    expect(() => createStopSignal("s", { redis, pollIntervalMs: 0 })).toThrow(RangeError);
  });
});
