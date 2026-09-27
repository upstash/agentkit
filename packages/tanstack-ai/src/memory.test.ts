import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chat } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { memoryMiddleware } from "@tanstack/ai-memory";
import { s } from "@upstash/redis";
import { AgentMemory } from "@upstash/agentkit-sdk";
import { memoryScopeKey, upstashMemory } from "./memory.js";
import { scriptedAdapter } from "./test-adapter.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueUserId } from "./test-support.js";

async function drain(stream: unknown): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of stream as AsyncIterable<StreamChunk>) out.push(c);
  return out;
}

async function pollUntil<T>(read: () => Promise<T>, ready: (v: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8_000;
  let value = await read();
  while (!ready(value) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    value = await read();
  }
  return value;
}

const promptText = (call: { systemPrompts?: unknown }) => JSON.stringify(call.systemPrompts ?? "");

describe("memoryScopeKey", () => {
  it("partitions by user across threads, and cannot be forged by separators", () => {
    expect(memoryScopeKey({ threadId: "t1", userId: "u" })).toBe(
      memoryScopeKey({ threadId: "t2", userId: "u" }),
    );
    expect(memoryScopeKey({ threadId: "t1", userId: "u" }, "thread")).not.toBe(
      memoryScopeKey({ threadId: "t2", userId: "u" }, "thread"),
    );
    expect(memoryScopeKey({ threadId: "t", userId: "a.u.b" })).not.toBe(
      memoryScopeKey({ threadId: "t", userId: "a", tenantId: "u.b" }),
    );
    expect(memoryScopeKey({ threadId: "t", userId: "_" })).not.toBe(
      memoryScopeKey({ threadId: "t" }),
    );
    expect(memoryScopeKey({ threadId: "x:y", userId: "a:b" })).not.toContain(":");
  });
});

describe.skipIf(!hasRedisCreds)("upstashMemory (live Redis, real chat loop)", () => {
  const redis = testRedis();
  const userId = uniqueUserId("tsmem");
  const other = uniqueUserId("tsmem-other");
  const adapter = upstashMemory({ redis });
  // A handle on the same index, only to wait for indexing between a write and the next recall.
  const index = new AgentMemory({
    redis,
    prefix: "agentkit:tanstackMemory",
    metadataSchema: { source: s.string().noTokenize() },
  }).searchIndex;

  beforeAll(async () => {
    // Provision the index before anything is written into its keyspace (see CLAUDE.md, Testing).
    await adapter.recall({ threadId: "probe", userId }, "provisioning probe");
  });

  afterAll(async () => {
    for (const u of [userId, other]) {
      await cleanupKeys(
        redis,
        `agentkit:tanstackMemory:${memoryScopeKey({ threadId: "x", userId: u })}:`,
      );
    }
  });

  it("a fact the model saves in one thread is recalled into the prompt of another thread", async () => {
    const mw = () =>
      memoryMiddleware({ adapter, scope: (ctx) => ({ threadId: ctx.threadId, userId }) });

    // Thread 1: the model calls save_memory, which the adapter offered as a tool this turn.
    const first = scriptedAdapter([
      {
        toolCalls: [
          { id: "s1", name: "save_memory", args: { text: "User is allergic to hazelnuts" } },
        ],
      },
      { text: "Noted." },
    ]);
    await drain(
      chat({
        adapter: first as never,
        threadId: "thread-1",
        messages: [{ role: "user", content: "remember: no hazelnuts for me" }],
        middleware: [mw()],
      }),
    );
    const offered = (first.calls[0]!.tools ?? []) as { name: string }[];
    expect(offered.map((t) => t.name)).toContain("save_memory");
    await index.waitIndexing();

    // Thread 2: recall runs before the model and injects the fact into the system prompt.
    const facts = await pollUntil(
      () => adapter.listFacts!({ threadId: "thread-2", userId }),
      (f) => f.some((x) => x.text.includes("hazelnuts") && x.source === "agent"),
    );
    expect(facts.some((x) => x.text.includes("hazelnuts"))).toBe(true);

    const second = scriptedAdapter([{ text: "Try the almond cake." }]);
    await drain(
      chat({
        adapter: second as never,
        threadId: "thread-2",
        messages: [{ role: "user", content: "suggest a dessert without hazelnuts" }],
        middleware: [mw()],
      }),
    );
    const prompt = promptText(second.calls[0]!);
    expect(prompt).toContain("User is allergic to hazelnuts");
    expect(prompt).toContain("you saved this");
  });

  it("captures user messages on save, labelled apart from saved facts", async () => {
    await adapter.save({ threadId: "t", userId }, { user: "I live in Izmir", assistant: "Nice!" });
    await index.waitIndexing();
    const recalled = await pollUntil(
      () => adapter.recall({ threadId: "t9", userId }, "where do I live Izmir"),
      (r) => r.systemPrompt.includes("Izmir"),
    );
    expect(recalled.systemPrompt).toContain("I live in Izmir (the user said this)");
  });

  it("is isolated per user", async () => {
    const r = await adapter.recall({ threadId: "t", userId: other }, "hazelnuts Izmir");
    expect(r.systemPrompt).toBe("");
    expect(r.fragments).toEqual([]);
  });
});
