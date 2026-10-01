/**
 * End to end, across two server instances of the demo app sharing one Upstash Redis: things TanStack
 * AI's in-memory backends cannot do, because each instance only sees its own memory.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, inject, it } from "vitest";
import { Redis } from "@upstash/redis";
import { memoryScopeKey } from "@upstash/agentkit-tanstack-ai/memory";
import {
  assistantText,
  newTurn,
  readEvents,
  reconstruct,
  resume,
  send,
  textOf,
  until,
} from "./client.js";

const instances = inject("instances");
const demoPrefix = inject("demoPrefix");
const users: string[] = [];

/** How many assistant messages a stream carries: two producers show up as two starts, interleaved. */
const messageStarts = (events: { chunk: { type: string } }[]) =>
  events.filter((e) => e.chunk.type === "TEXT_MESSAGE_START").length;

const deltaCount = (n: number) => (events: { chunk: { type: string } }[]) =>
  events.filter((e) => e.chunk.type === "TEXT_MESSAGE_CONTENT").length >= n;

/** The whole answer of a run, replayed from the start of its durable log. */
async function fullAnswer(base: string, runId: string): Promise<string> {
  const res = await fetch(`${base}/api/chat?offset=-1&runId=${encodeURIComponent(runId)}`);
  return textOf(await readEvents(res));
}

describe.skipIf(!instances)("demo app, two instances, one Upstash Redis", () => {
  const { a, b } = instances ?? { a: "", b: "" };

  afterAll(async () => {
    const redis = Redis.fromEnv();
    const patterns = [
      `${demoPrefix}:*`,
      ...users.map((u) => `agentkit:tanstackMemory:${memoryScopeKey({ threadId: "_", userId: u })}:*`),
    ];
    for (const match of patterns) {
      let cursor = "0";
      do {
        const [next, keys] = await redis.scan(cursor, { match, count: 500 });
        if (keys.length) await redis.del(...keys);
        cursor = String(next);
      } while (cursor !== "0");
    }
  });

  it("a client that drops mid-answer on A resumes the same run on B, missing nothing", async () => {
    const turn = newTurn("hello there");
    const controller = new AbortController();
    const before = await readEvents(await send(a, turn, controller.signal), deltaCount(5));
    controller.abort();
    const lastOffset = before.findLast((e) => e.id)?.id;
    expect(lastOffset).toBeTruthy();

    // The "reloaded" browser reconnects to the OTHER instance with the last offset it saw.
    const after = await readEvents(await resume(b, lastOffset!));
    expect(after.at(-1)?.chunk.type).toBe("RUN_FINISHED");
    expect(after.some((e) => e.id === lastOffset)).toBe(false); // strictly after, no duplicates

    const stitched = textOf(before) + textOf(after);
    expect(stitched).toBe(await fullAnswer(b, turn.runId));
    expect(stitched.startsWith("You said: hello there.")).toBe(true);
    expect(stitched.endsWith("the very last word arrives.")).toBe(true);
  });

  it("a reload on B mid-answer finds the run still in flight on A, then the finished transcript", async () => {
    const turn = newTurn("how are you");
    const controller = new AbortController();
    await readEvents(await send(a, turn, controller.signal), deltaCount(3));
    controller.abort(); // closed tab: the run keeps going on A

    const midway = await reconstruct(b, turn.threadId);
    expect(midway.activeRun?.runId).toBe(turn.runId);

    const done = await until(
      () => reconstruct(b, turn.threadId),
      (t) => t.activeRun === null && assistantText(t).includes("arrives."),
    );
    expect(done.activeRun).toBeNull();
    expect(assistantText(done)).toBe(await fullAnswer(b, turn.runId));
    expect(done.messages.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("a fact saved in one thread on A is recalled in a new thread on B", async () => {
    const user = `e2e-user-${randomUUID()}`;
    users.push(user);
    const fact = `I like green tea ${randomUUID().slice(0, 8)}`;

    const saving = await readEvents(await send(a, newTurn(`remember: ${fact}`, { user })));
    expect(saving.some((e) => e.chunk.type === "TOOL_CALL_START")).toBe(true);
    expect(textOf(saving)).toContain("Saved.");

    const asking = await readEvents(await send(b, newTurn("what do you know about me?", { user })));
    // Recalled into the prompt on B: the saved fact (and the captured message it came from).
    expect(textOf(asking)).toMatch(/I remember: .*I like green tea/);
    expect(textOf(asking)).toContain(fact);

    // Another user sees none of it.
    const stranger = `e2e-user-${randomUUID()}`;
    users.push(stranger);
    const other = await readEvents(await send(b, newTurn("what do you know about me?", { user: stranger })));
    expect(textOf(other)).not.toContain(fact);
  });

  it("a run that outlives its producer lease is still produced once when re-POSTed elsewhere", async () => {
    const turn = newTurn("long: a long one");
    const first = send(a, turn).then((res) => readEvents(res));
    // Mid-run (the answer takes ~6s) and past the 1s lease: without renewal, B would take the lock
    // and start a second producer writing into the same log.
    await new Promise((r) => setTimeout(r, 2_000));
    const second = await readEvents(await send(b, turn));
    const fromA = await first;
    expect(textOf(second)).toBe(textOf(fromA));
    // A second producer would interleave a second answer into the same log.
    expect(messageStarts(fromA)).toBe(1);
    expect(messageStarts(second)).toBe(1);
    const thread = await until(
      () => reconstruct(a, turn.threadId),
      (t) => t.activeRun === null,
    );
    expect(thread.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("rejects a malformed request with a 400", async () => {
    const res = await fetch(`${a}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: "nope" }),
    });
    expect(res.status).toBe(400);
  });

  it("the same run POSTed to both instances at once is produced exactly once", async () => {
    const turn = newTurn("only once please");
    const [fromA, fromB] = await Promise.all([
      send(a, turn).then((res) => readEvents(res)),
      send(b, turn).then((res) => readEvents(res)),
    ]);
    // Both clients see the same single answer, tailed from one log.
    expect(textOf(fromA)).toBe(textOf(fromB));
    expect(messageStarts(fromA)).toBe(1);
    expect(messageStarts(fromB)).toBe(1);

    const thread = await until(
      () => reconstruct(a, turn.threadId),
      (t) => t.activeRun === null,
    );
    expect(thread.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  });
});
