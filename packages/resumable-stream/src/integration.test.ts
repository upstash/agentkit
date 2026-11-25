import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import { afterAll, describe, expect, it, vi } from "vitest";
import { DONE_MESSAGE } from "./codec.js";
import { createResumableStreamContext } from "./context.js";
import { createUpstashPublisher } from "./publisher.js";
import { createStopSignal, requestStop } from "./stop.js";
import { createUpstashSubscriber } from "./subscriber.js";

const hasRedisCreds = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
);

/** Each "instance" gets its own client and context, as two serverless invocations would. */
const keyPrefix = `test:resumable:${randomUUID().slice(0, 8)}`;
const instance = () =>
  createResumableStreamContext({ waitUntil: null, keyPrefix, redis: Redis.fromEnv() });

function source() {
  let write!: (chunk: string) => void;
  let close!: () => void;
  const readable = new ReadableStream<string>({
    start: (c) => {
      write = (chunk) => c.enqueue(chunk);
      close = () => c.close();
    },
  });
  return { readable, write, close };
}

async function readAll(stream: ReadableStream<string> | null | undefined): Promise<string> {
  let text = "";
  for (const reader = stream!.getReader(); ; ) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += value;
  }
}

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 10_000) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const tick = () => new Promise((r) => setTimeout(r, 50));

describe.skipIf(!hasRedisCreds)("resumable-stream on Upstash Redis", () => {
  afterAll(async () => {
    const redis = Redis.fromEnv();
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, { match: `${keyPrefix}*`, count: 200 });
      if (keys.length) await redis.del(...keys);
      cursor = next;
    } while (cursor !== "0");
  });

  it("streams text that only survives inside the envelope", async () => {
    const chunks = ["data: 1\n\n", "42", "null", "\n\n\n", 'data: {"x":"y"}\n\n'];
    const s = source();
    const a = instance();
    const original = readAll(await a.resumableStream("envelope", () => s.readable));
    s.write(chunks[0]!);
    await tick();
    const resumed = readAll(await instance().resumeExistingStream("envelope"));
    for (const chunk of chunks.slice(1)) s.write(chunk);
    s.close();
    expect(await original).toBe(chunks.join(""));
    expect(await resumed).toBe(chunks.join(""));
  });

  it("resumes mid-stream on another instance, in order, then reports done", async () => {
    const s = source();
    const a = instance();
    const b = instance();
    const original = readAll(await a.resumableStream("resume", () => s.readable));
    s.write("first ");
    await tick();
    const resumed = readAll(await b.resumeExistingStream("resume"));
    const burst = Array.from({ length: 200 }, (_, i) => `data: ${i}\n\n`);
    for (const chunk of burst) s.write(chunk);
    s.close();
    expect(await resumed).toBe("first " + burst.join(""));
    expect(await original).toBe("first " + burst.join(""));

    expect(await until(async () => (await b.hasExistingStream("resume")) === "DONE")).toBe(true);
    expect(await b.resumeExistingStream("resume")).toBeNull();
    // INCR on the DONE sentinel must fail the way resumable-stream recognises.
    expect(await b.resumableStream("resume", () => s.readable)).toBeNull();
  });

  it("delivers a replay over 1 MiB in pieces", async () => {
    const s = source();
    await instance().resumableStream("large", () => s.readable);
    const replay = 'data: {"delta":"hello é日😀"}\n\n'.repeat(30_000);
    expect(Buffer.byteLength(replay)).toBeGreaterThan(1024 * 1024);
    s.write(replay);
    await tick();
    const resumed = readAll(await instance().resumeExistingStream("large"));
    s.write("tail");
    s.close();
    expect(await resumed).toBe(replay + "tail");
  });

  it("stops a producer from another instance", async () => {
    const streamId = `${keyPrefix}:stop`;
    const stop = createStopSignal(streamId, { pollIntervalMs: 200 });
    await new Promise((r) => setTimeout(r, 500));
    expect(stop.signal.aborted).toBe(false);
    await requestStop(streamId);
    expect(await until(() => stop.signal.aborted, 5000)).toBe(true);
    stop.dispose();
    await Redis.fromEnv().del(`agentkit:stop:${streamId}`);
  });

  it("unsubscribe ends the subscription on the server", async () => {
    const redis = Redis.fromEnv();
    const channel = `${keyPrefix}:channel`;
    // PUBLISH returns how many subscribers received the message. PUBSUB NUMSUB lagged in CI.
    const receivers = () => redis.publish(channel, '{"d":"ping"}');
    const subscriber = createUpstashSubscriber();
    await subscriber.subscribe(channel, () => undefined);
    expect(await until(async () => (await receivers()) === 1)).toBe(true);
    await subscriber.unsubscribe(channel);
    expect(await until(async () => (await receivers()) === 0)).toBe(true);
  });

  it("never rejects a publish after a failed send", async () => {
    // The server refuses a wrong token, so every send fails. A rejection would stop the producer's
    // read loop and freeze the original reader, so the channel's messages are dropped instead.
    const url = process.env.UPSTASH_REDIS_REST_URL!;
    const publisher = createUpstashPublisher(new Redis({ url, token: "wrong", retry: false }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // DONE in the batch that fails.
      void publisher.publish(`${keyPrefix}:broken:1`, "a");
      await expect(publisher.publish(`${keyPrefix}:broken:1`, DONE_MESSAGE)).resolves.toBe(0);
      expect(errors).toHaveBeenCalledTimes(1);

      // Publishes and DONE after the channel failed.
      await expect(publisher.publish(`${keyPrefix}:broken:2`, "a")).resolves.toBe(1);
      expect(await until(() => errors.mock.calls.length === 2)).toBe(true);
      await expect(publisher.publish(`${keyPrefix}:broken:2`, "b")).resolves.toBe(0);
      await expect(publisher.publish(`${keyPrefix}:broken:2`, DONE_MESSAGE)).resolves.toBe(0);
      expect(errors).toHaveBeenCalledTimes(2); // once per channel
    } finally {
      errors.mockRestore();
    }
  });
});
