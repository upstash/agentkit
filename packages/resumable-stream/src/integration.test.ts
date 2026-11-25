import { afterAll, describe, expect, it } from "vitest";
import { createActiveStreamStore } from "./active-stream-store.js";
import { createResumableStreamContext } from "./context.js";
import type { UpstashPublisherOptions } from "./publisher.js";
import { createStopSignal, requestStop, StopRequestedError } from "./stop.js";
import { createUpstashSubscriber } from "./subscriber.js";
import {
  cleanupKeys,
  controlledSource,
  hasRedisCreds,
  pollUntil,
  readAll,
  testRedis,
  tick,
  uniquePrefix,
} from "./test-support.js";

/**
 * Against a real Upstash Redis, over HTTP. Each "instance" is its own Redis client and context, as
 * two serverless invocations would be.
 */
describe.skipIf(!hasRedisCreds)("integration (real Upstash Redis)", () => {
  const prefix = uniquePrefix("resumable");
  const instance = (publisherOptions: Omit<UpstashPublisherOptions, "enableTelemetry"> = {}) =>
    createResumableStreamContext({
      waitUntil: null,
      keyPrefix: prefix,
      redis: testRedis(),
      publisherOptions,
    });

  afterAll(async () => {
    await cleanupKeys(testRedis(), prefix);
  });

  it("creates a stream and reads it to the end", async () => {
    const ctx = instance();
    const chunks = ["data: 1\n\n", "42", "\n\n\n", 'data: {"x":"y"}\n\n', "null"];
    const stream = await ctx.resumableStream(
      "create",
      () =>
        new ReadableStream<string>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
    );
    expect(await readAll(stream as ReadableStream<string>)).toBe(chunks.join(""));
    expect(await pollUntil(async () => (await ctx.hasExistingStream("create")) === "DONE")).toBe(
      true,
    );
  });

  it("resumes mid-stream from a second instance, in order", async () => {
    const a = instance();
    const b = instance();
    const source = controlledSource();
    const original = await a.resumableStream("resume", () => source.readable);
    const originalText = readAll(original as ReadableStream<string>);
    source.write("data: first\n\n");
    source.write("7");
    await tick(50);

    const resumed = await b.resumeExistingStream("resume");
    expect(resumed).toBeInstanceOf(ReadableStream);
    const resumedText = readAll(resumed as ReadableStream<string>);
    // A burst while the listener is attached: the batched publisher keeps it in order.
    const burst = Array.from({ length: 200 }, (_, i) => `data: ${i}\n\n`);
    for (const chunk of burst) source.write(chunk);
    source.close();

    const expected = "data: first\n\n7" + burst.join("");
    expect(await originalText).toBe(expected);
    expect(await resumedText).toBe(expected);
  });

  it("returns null when resuming a stream that is done", async () => {
    const a = instance();
    const b = instance();
    const first = await a.resumableStream(
      "done",
      () =>
        new ReadableStream<string>({
          start(controller) {
            controller.enqueue("all of it");
            controller.close();
          },
        }),
    );
    await readAll(first as ReadableStream<string>);
    expect(await pollUntil(async () => (await b.hasExistingStream("done")) === "DONE")).toBe(true);

    expect(await b.resumeExistingStream("done")).toBeNull();
    // resumableStream INCRs the sentinel; INCR on "DONE" must surface the error resumable-stream
    // recognises, or it would start a second producer.
    expect(
      await b.resumableStream("done", () => {
        throw new Error("must not start a second producer");
      }),
    ).toBeNull();
  });

  it("delivers a replay over 1 MiB, split into pieces", async () => {
    // Unsplit, this one message would exceed what @upstash/redis buffers per subscription message
    // (1 MiB), and on smaller plans the max request size.
    const a = instance();
    const b = instance();
    const source = controlledSource();
    await a.resumableStream("large", () => source.readable);
    const replay = 'data: {"type":"text-delta","delta":"hello é日😀"}\n\n'.repeat(25_000);
    expect(Buffer.byteLength(replay)).toBeGreaterThan(1024 * 1024);
    source.write(replay);
    await tick(50);

    const resumed = await b.resumeExistingStream("large");
    const text = readAll(resumed as ReadableStream<string>);
    source.write("tail");
    source.close();
    expect(await text).toBe(replay + "tail");
  });

  it("stops a producer from another instance", async () => {
    const stopPrefix = `${prefix}:stop`;
    const stop = createStopSignal("stop-me", {
      redis: testRedis(),
      prefix: stopPrefix,
      pollIntervalMs: 200,
    });
    await tick(500);
    expect(stop.signal.aborted).toBe(false);

    await requestStop("stop-me", { redis: testRedis(), prefix: stopPrefix, ttlSeconds: 60 });
    expect(await pollUntil(() => stop.signal.aborted, 5000)).toBe(true);
    expect(stop.signal.reason).toBeInstanceOf(StopRequestedError);
    stop.dispose();
  });

  it("registry: clear only removes the stream it was given (the finish/restart race)", async () => {
    const store = createActiveStreamStore({ redis: testRedis(), prefix: `${prefix}:active` });
    const other = createActiveStreamStore({ redis: testRedis(), prefix: `${prefix}:active` });

    expect(await store.get("chat")).toBeNull();
    await store.set("chat", "007");
    expect(await other.get("chat")).toBe("007"); // not the number 7

    // Stream A finishes after stream B started for the same chat: A's clear must not remove B.
    await store.set("chat", "stream-a");
    await other.set("chat", "stream-b");
    expect(await store.clear("chat", "stream-a")).toBe(false);
    expect(await store.get("chat")).toBe("stream-b");

    // Two concurrent clears of the same stream: exactly one wins.
    const results = await Promise.all([
      store.clear("chat", "stream-b"),
      other.clear("chat", "stream-b"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.get("chat")).toBeNull();
  });

  it("unsubscribe ends the subscription on the server", async () => {
    const redis = testRedis();
    const channel = `${prefix}:unsubscribe`;
    const numsub = async () => {
      const reply = (await redis.exec(["PUBSUB", "NUMSUB", channel])) as [string, number];
      return Number(reply[1]);
    };
    const subscriber = createUpstashSubscriber(testRedis());
    await subscriber.subscribe(channel, () => undefined);
    expect(await numsub()).toBe(1);
    await subscriber.unsubscribe(channel);
    expect(await pollUntil(async () => (await numsub()) === 0, 10_000, 200)).toBe(true);
  });
});
