import { describe, expect, it, vi } from "vitest";
import { DONE_MESSAGE, decodeMessage } from "./codec.js";
import { createUpstashPublisher } from "./publisher.js";
import { MemoryRedisServer } from "./testing/memory-redis.js";

const received = (server: MemoryRedisServer, channel: string) =>
  (server.published.get(channel) ?? []).map(decodeMessage);

describe("createUpstashPublisher", () => {
  it("resolves publishes at once, sends them in order, and flushes before DONE", async () => {
    const server = new MemoryRedisServer({ latencyMs: 20 });
    const publisher = createUpstashPublisher(server.client(), { enableTelemetry: false });
    const chunks = Array.from({ length: 50 }, (_, i) => `chunk ${i}\n`);

    // What resumable-stream's producer does: await each publish before reading the next chunk.
    const started = Date.now();
    for (const chunk of chunks) await publisher.publish("ch", chunk);
    expect(Date.now() - started).toBeLessThan(20 * 5); // not one round trip per chunk

    await publisher.publish("ch", DONE_MESSAGE);
    expect(received(server, "ch")).toEqual([...chunks, DONE_MESSAGE]);
    // A handful of pipeline requests instead of 51 publishes.
    expect(server.requests.length).toBeLessThan(10);
  });

  it("keeps channels independent and in order", async () => {
    const server = new MemoryRedisServer({ latencyMs: 5 });
    const publisher = createUpstashPublisher(server.client(), { enableTelemetry: false });
    for (let i = 0; i < 20; i++) {
      await Promise.all([publisher.publish("a", `a${i}`), publisher.publish("b", `b${i}`)]);
    }
    await Promise.all([publisher.publish("a", DONE_MESSAGE), publisher.publish("b", DONE_MESSAGE)]);
    expect(received(server, "a")).toEqual([
      ...Array.from({ length: 20 }, (_, i) => `a${i}`),
      DONE_MESSAGE,
    ]);
    expect(received(server, "b")).toEqual([
      ...Array.from({ length: 20 }, (_, i) => `b${i}`),
      DONE_MESSAGE,
    ]);
  });

  it("with batch: false, each publish waits for its own request", async () => {
    const server = new MemoryRedisServer({ latencyMs: 10 });
    const publisher = createUpstashPublisher(server.client(), {
      batch: false,
      enableTelemetry: false,
    });
    await publisher.publish("ch", "one");
    expect(received(server, "ch")).toEqual(["one"]);
    await publisher.publish("ch", "two");
    expect(received(server, "ch")).toEqual(["one", "two"]);
  });

  it("splits a message over maxMessageBytes and keeps requests under maxBatchBytes", async () => {
    const server = new MemoryRedisServer({ maxRequestBytes: 64 * 1024 });
    const publisher = createUpstashPublisher(server.client(), {
      maxMessageBytes: 8 * 1024,
      maxBatchBytes: 32 * 1024,
      enableTelemetry: false,
    });
    const replay = 'data: {"type":"text-delta","delta":"hello"}\n\n'.repeat(10_000); // ~470 KB
    await publisher.publish("ch", replay);
    await publisher.publish("ch", DONE_MESSAGE);
    const messages = received(server, "ch");
    expect(messages.length).toBeGreaterThan(50);
    expect(messages.at(-1)).toBe(DONE_MESSAGE);
    expect(messages.slice(0, -1).join("")).toBe(replay);
    for (const request of server.requests) expect(request.bytes).toBeLessThanOrEqual(64 * 1024);
  });

  it("without splitting, the same replay would be rejected", async () => {
    const server = new MemoryRedisServer({ maxRequestBytes: 64 * 1024 });
    await expect(server.client().publish("ch", "x".repeat(100 * 1024))).rejects.toThrow(
      /max request size/,
    );
  });

  it("surfaces a failed batch: onError, then the next publish and DONE reject", async () => {
    const server = new MemoryRedisServer();
    const onError = vi.fn();
    const publisher = createUpstashPublisher(server.client(), { onError, enableTelemetry: false });
    server.failNext = 1;
    await publisher.publish("ch", "lost"); // resolved before it is sent
    await publisher.flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toBe("ch");
    await expect(publisher.publish("ch", "next")).rejects.toThrow(/simulated failure/);
    await expect(publisher.publish("ch", DONE_MESSAGE)).rejects.toThrow(/simulated failure/);
    // Another channel is unaffected, and the failed one is forgotten after its DONE.
    await publisher.publish("other", DONE_MESSAGE);
    expect(received(server, "other")).toEqual([DONE_MESSAGE]);
    await publisher.publish("ch", DONE_MESSAGE);
    expect(received(server, "ch")).toEqual([DONE_MESSAGE]);
  });

  it("rejects the DONE message itself when its batch fails", async () => {
    const server = new MemoryRedisServer();
    const onError = vi.fn();
    const publisher = createUpstashPublisher(server.client(), { onError, enableTelemetry: false });
    await publisher.publish("ch", "a");
    await publisher.flush();
    server.failNext = 1;
    await expect(publisher.publish("ch", DONE_MESSAGE)).rejects.toThrow(/simulated failure/);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("maps set/get/incr to Redis, including INCR on a DONE sentinel", async () => {
    const server = new MemoryRedisServer();
    const publisher = createUpstashPublisher(server.client(), { enableTelemetry: false });
    expect(await publisher.get("k")).toBeNull();
    expect(await publisher.incr("k")).toBe(1);
    await publisher.set("k", "DONE", { EX: 60 });
    expect(await publisher.get("k")).toBe("DONE");
    await expect(publisher.incr("k")).rejects.toThrow(
      "ERR value is not an integer or out of range",
    );
  });
});
