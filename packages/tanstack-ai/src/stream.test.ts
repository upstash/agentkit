import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { replayRunStream, toServerSentEventsResponse } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { Redis } from "@upstash/redis";
import { upstashStream } from "./stream.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniquePrefix } from "./test-support.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function text(delta: string): StreamChunk {
  return {
    type: "TEXT_MESSAGE_CONTENT",
    messageId: "m1",
    delta,
    timestamp: Date.now(),
  } as unknown as StreamChunk;
}

const deltas = (chunks: StreamChunk[]) =>
  chunks.map((c) => (c as { delta?: string }).delta).filter((d): d is string => d !== undefined);

/** A "second server instance": its own client, so nothing is shared in-process. */
const otherInstance = () => Redis.fromEnv();

describe.skipIf(!hasRedisCreds)("upstashStream (live Redis)", () => {
  const redis = testRedis();
  const prefix = uniquePrefix("tss");
  const cfg = { redis, prefix, pollIntervalMs: 50 };

  afterAll(async () => {
    await cleanupKeys(redis, prefix);
  });

  it("persists a produced SSE response and replays it from another instance", async () => {
    const runId = randomUUID();
    async function* produce() {
      for (const d of ["Hel", "lo", " world"]) yield text(d);
    }
    const res = toServerSentEventsResponse(produce(), {
      durability: { adapter: upstashStream({ runId }, cfg) },
    });
    const body = await res.text();
    expect(body).toContain("Hel");

    const joiner = upstashStream({ runId }, { ...cfg, redis: otherInstance() });
    const replayed: StreamChunk[] = [];
    for await (const c of replayRunStream(joiner)) replayed.push(c);
    expect(deltas(replayed)).toEqual(["Hel", "lo", " world"]);
  });

  it("resumes strictly after a client's last offset (reload mid-answer)", async () => {
    const runId = randomUUID();
    const producer = upstashStream({ runId }, cfg);
    const offsets = await producer.append([text("a"), text("b"), text("c")]);
    await producer.close();

    // The browser reconnects with Last-Event-ID set to the offset it saw last.
    const request = new Request("https://app.test/api/chat", {
      headers: { "Last-Event-ID": offsets[0]! },
    });
    const resumed = upstashStream(request, { ...cfg, redis: otherInstance() });
    expect(resumed.resumeFrom()).toBe(offsets[0]);
    const seen: string[] = [];
    for await (const e of resumed.read(resumed.resumeFrom()!)) {
      seen.push((e.chunk as { delta: string }).delta);
    }
    expect(seen).toEqual(["b", "c"]);
  });

  it("a joiner attached mid-run tails live chunks until the producer closes", async () => {
    const runId = randomUUID();
    const producer = upstashStream({ runId }, cfg);
    await producer.append([text("1")]);

    const joiner = upstashStream({ runId }, { ...cfg, redis: otherInstance() });
    const seen: StreamChunk[] = [];
    const reading = (async () => {
      for await (const c of replayRunStream(joiner)) seen.push(c);
    })();

    await sleep(150);
    await producer.append([text("2"), text("3")]);
    await sleep(150);
    await producer.append([text("4")]);
    await producer.close();
    await reading;
    expect(deltas(seen)).toEqual(["1", "2", "3", "4"]);
  });

  it("reads the run id from X-Run-Id on a producer request", () => {
    const request = new Request("https://app.test/api/chat", { headers: { "X-Run-Id": "run-42" } });
    const s = upstashStream(request, cfg);
    expect(s.resumeFrom()).toBeNull();
  });

  it("snapshot returns the stored prefix without waiting on an open log", async () => {
    const runId = randomUUID();
    const producer = upstashStream({ runId }, cfg);
    expect(await producer.snapshot()).toEqual([]);
    const offsets = await producer.append([text("x"), text("y")]);
    const snap = await producer.snapshot();
    expect(snap.map((e) => e.offset)).toEqual(offsets);
    expect(deltas(snap.map((e) => e.chunk))).toEqual(["x", "y"]);
  });

  it("fails loudly for a concrete offset of an unknown run", async () => {
    const runId = randomUUID();
    const producer = upstashStream({ runId }, cfg);
    const [offset] = await producer.append([text("z")]);
    await redis.del(`${prefix}:events:${runId}`); // expired
    const stale = upstashStream({ runId, offset: offset! }, cfg);
    const drain = async () => {
      for await (const _ of stale.read(offset!)) void _;
    };
    await expect(drain()).rejects.toThrow(/Unknown or expired/);
  });

  it("rejects a from-start join on a run that never produces", async () => {
    const s = upstashStream({ runId: randomUUID() }, { ...cfg, firstChunkDeadlineMs: 200 });
    const drain = async () => {
      for await (const _ of s.read("-1")) void _;
    };
    await expect(drain()).rejects.toThrow(/no entries/);
  });

  it("rejects an offset that belongs to a different run", async () => {
    const a = upstashStream({ runId: "run-a-" + randomUUID() }, cfg);
    const [offset] = await a.append([text("q")]);
    const b = upstashStream({ runId: "run-b-" + randomUUID() }, cfg);
    const drain = async () => {
      for await (const _ of b.read(offset!)) void _;
    };
    await expect(drain()).rejects.toThrow(/belongs to run/);
  });
});
