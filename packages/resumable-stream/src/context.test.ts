import { describe, expect, it } from "vitest";
import { createResumableStreamContext } from "./context.js";
import { MemoryRedisServer } from "./testing/memory-redis.js";
import { controlledSource, pollUntil, readAll, tick } from "./test-support.js";

/**
 * The real resumable-stream runtime over the in-memory server: two contexts on two clients stand
 * in for two server instances. The same flows run against real Upstash in integration.test.ts.
 */
function instances(server: MemoryRedisServer, publisherOptions = {}) {
  const make = () =>
    createResumableStreamContext({
      waitUntil: null,
      redis: server.client(),
      publisherOptions,
      enableTelemetry: false,
    });
  return [make(), make()] as const;
}

describe("createResumableStreamContext (in-memory server)", () => {
  it("resumes a stream mid-way on another instance, then reports it done", async () => {
    const server = new MemoryRedisServer({ latencyMs: 2 });
    const [a, b] = instances(server);
    const source = controlledSource();
    const original = await a.createNewResumableStream("s1", () => source.readable);
    const originalText = readAll(original as ReadableStream<string>);

    source.write("data: 1\n\n");
    source.write("42");
    await tick();
    const resumed = await b.resumeExistingStream("s1");
    expect(resumed).toBeInstanceOf(ReadableStream);
    const resumedText = readAll(resumed as ReadableStream<string>);
    for (let i = 0; i < 100; i++) source.write(`data: ${i}\n\n`);
    source.close();

    const expected =
      "data: 1\n\n42" + Array.from({ length: 100 }, (_, i) => `data: ${i}\n\n`).join("");
    expect(await originalText).toBe(expected);
    expect(await resumedText).toBe(expected);

    expect(await pollUntil(async () => (await b.hasExistingStream("s1")) === "DONE")).toBe(true);
    expect(await b.resumeExistingStream("s1")).toBeNull();
    expect(
      await b.resumableStream("s1", () => {
        throw new Error("must not start a second producer");
      }),
    ).toBeNull();
  });

  it("delivers a replay larger than the server's request limit, split into pieces", async () => {
    const server = new MemoryRedisServer({ maxRequestBytes: 16 * 1024 });
    const [a, b] = instances(server, { maxMessageBytes: 4 * 1024, maxBatchBytes: 12 * 1024 });
    const source = controlledSource();
    await a.createNewResumableStream("big", () => source.readable);
    const replay = 'data: {"type":"text-delta","delta":"é日😀"}\n\n'.repeat(3000);
    source.write(replay);
    await tick();
    const resumed = await b.resumeExistingStream("big");
    const text = readAll(resumed as ReadableStream<string>);
    source.write("tail");
    source.close();
    expect(await text).toBe(replay + "tail");
    for (const request of server.requests) expect(request.bytes).toBeLessThanOrEqual(16 * 1024);
  });

  it("returns undefined when resuming a stream that never existed", async () => {
    const [, b] = instances(new MemoryRedisServer());
    expect(await b.resumeExistingStream("missing")).toBeUndefined();
  });
});
