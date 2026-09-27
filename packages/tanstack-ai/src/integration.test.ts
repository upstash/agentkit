import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { chat, replayRunStream, toServerSentEventsResponse } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { withPersistence } from "@tanstack/ai-persistence";
import { upstashPersistence } from "./persistence.js";
import { upstashStream } from "./stream.js";
import { scriptedAdapter } from "./test-adapter.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniquePrefix } from "./test-support.js";

// The pieces together, the way an app route wires them: persistence middleware on `chat()`, the
// durable stream on the SSE response, and a second "instance" reading both back.
describe.skipIf(!hasRedisCreds)("persistence + resumable stream in a real chat() route", () => {
  const redis = testRedis();
  const prefix = uniquePrefix("tsint");
  afterAll(async () => {
    await cleanupKeys(redis, prefix);
  });

  it("a finished run leaves a reloadable transcript, a completed run record, and a replayable stream", async () => {
    const threadId = `thread-${randomUUID()}`;
    const runId = randomUUID();
    const persistence = upstashPersistence({ redis, prefix: `${prefix}:state` });
    const adapter = scriptedAdapter([{ text: "Hi Arda, how can I help?" }]);

    const stream = chat({
      adapter: adapter as never,
      threadId,
      runId,
      messages: [{ role: "user", content: "hello" }],
      middleware: [withPersistence(persistence)],
    } as never);
    const response = toServerSentEventsResponse(stream as AsyncIterable<StreamChunk>, {
      durability: { adapter: upstashStream({ runId }, { redis, prefix: `${prefix}:stream` }) },
    });
    expect(await response.text()).toContain("how can I help");

    // Another instance: fresh store objects over the same Redis.
    const reloaded = upstashPersistence({ redis: testRedis(), prefix: `${prefix}:state` });
    const transcript = await reloaded.stores.messages.loadThread(threadId);
    expect(JSON.stringify(transcript)).toContain("hello");
    expect(JSON.stringify(transcript)).toContain("how can I help");

    const runs = await reloaded.stores.runs.listByThread!(threadId);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((r) => r.status === "completed")).toBe(true);
    expect(await reloaded.stores.runs.findActiveRun(threadId)).toBeNull();

    const replayed: string[] = [];
    const joiner = upstashStream({ runId }, { redis: testRedis(), prefix: `${prefix}:stream` });
    for await (const c of replayRunStream(joiner)) {
      const delta = (c as { delta?: string }).delta;
      if (delta) replayed.push(delta);
    }
    expect(replayed.join("")).toBe("Hi Arda, how can I help?");
  });
});
