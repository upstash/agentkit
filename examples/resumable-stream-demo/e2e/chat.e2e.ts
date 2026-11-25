/**
 * End to end, across two server instances of the demo app sharing one Upstash Redis: an answer
 * started on one instance is resumed or stopped from the other, with the scripted model, no mocks.
 */
import { afterAll, describe, expect, inject, it } from "vitest";
import { Redis } from "@upstash/redis";
import type { UIMessage } from "ai";
import { chatKey, readChat } from "../lib/chat-store.js";
import { scriptedAnswer } from "../lib/model.js";
import { deltaCount, newChatId, readChunks, resume, send, stop, textOf, until } from "./client.js";

const instances = inject("instances");
const chats: string[] = [];
const streams: string[] = [];

/** A fresh chat id that `afterAll` cleans up. */
function chat(): string {
  const id = newChatId();
  chats.push(id);
  return id;
}

/** The stream id the POST registered on the chat (set once its resumable stream exists). */
async function activeStream(chatId: string): Promise<string> {
  const { activeStreamId } = await until(
    () => readChat(chatId),
    (c) => c.activeStreamId !== null,
  );
  expect(activeStreamId).toBeTruthy();
  streams.push(activeStreamId!);
  return activeStreamId!;
}

/** The chat once the producer's `onEnd` saved it: the assistant answer last, no active stream. */
async function savedChat(chatId: string) {
  return until(
    () => readChat(chatId),
    (c) => c.activeStreamId === null && c.messages.at(-1)?.role === "assistant",
  );
}

const textOfMessage = (m: UIMessage | undefined) =>
  (m?.parts ?? []).map((p) => (p.type === "text" ? p.text : "")).join("");

describe.skipIf(!instances)("demo app, two instances, one Upstash Redis", () => {
  const { a, b } = instances ?? { a: "", b: "" };

  afterAll(async () => {
    const keys = [
      ...chats.map(chatKey),
      ...streams.flatMap((s) => [`resumable-stream:rs:sentinel:${s}`, `agentkit:stop:${s}`]),
    ];
    if (keys.length) await Redis.fromEnv().del(...keys);
  });

  it("a client that drops mid-answer on A resumes it on B, missing nothing", async () => {
    const id = chat();
    const full = scriptedAnswer("hello there");
    const controller = new AbortController();
    const sent = await send(a, id, "hello there", controller.signal);
    const before = textOf(await readChunks(sent, deltaCount(5)));
    controller.abort(); // closed tab: the answer keeps going on A
    await activeStream(id);
    expect(before.length).toBeGreaterThan(0);

    // The reloaded browser lands on the OTHER instance. resumable-stream replays the stream from its
    // first character, so the resumed text repeats what A already delivered, then carries on.
    const res = await resume(b, id);
    expect(res.status).toBe(200);
    const after = await readChunks(res);
    expect(after.at(-1)?.type).toBe("finish");
    const resumed = textOf(after);
    expect(resumed.startsWith(before)).toBe(true);
    expect(before + resumed.slice(before.length)).toBe(full);

    const saved = await savedChat(id);
    expect(saved.activeStreamId).toBeNull();
    expect(saved.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(textOfMessage(saved.messages.at(-1))).toBe(full);
    for (const base of [a, b]) {
      expect((await resume(base, id)).status).toBe(204);
      // The chat page each instance renders holds the whole answer.
      expect(await (await fetch(`${base}/chat/${id}`)).text()).toContain(full);
    }
  });

  it("Stop on B ends an answer being generated on A, and the partial answer is saved", async () => {
    const id = chat();
    const full = scriptedAnswer("please stop");
    let seen = 0;
    const reading = readChunks(await send(a, id, "please stop"), (chunks) => {
      seen = chunks.filter((c) => c.type === "text-delta").length;
      return false;
    });
    await activeStream(id);
    await until(
      async () => seen,
      (n) => n >= 10,
    );

    expect((await stop(b, id)).status).toBe(204);
    const text = textOf(await reading); // ends early instead of running to the end of the script
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThan(full.length);
    expect(full.startsWith(text)).toBe(true);

    const saved = await savedChat(id);
    const partial = textOfMessage(saved.messages.at(-1));
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(full.length);
    expect(full.startsWith(partial)).toBe(true);
    expect(saved.activeStreamId).toBeNull();
    expect((await resume(a, id)).status).toBe(204);
    expect((await resume(b, id)).status).toBe(204);
  });

  it("once an answer is done, a resume on either instance finds no stream", async () => {
    const id = chat();
    const reading = send(a, id, "all done").then((res) => readChunks(res));
    await activeStream(id);
    expect(textOf(await reading)).toBe(scriptedAnswer("all done"));

    await savedChat(id);
    expect((await resume(a, id)).status).toBe(204);
    expect((await resume(b, id)).status).toBe(204);
  });
});
