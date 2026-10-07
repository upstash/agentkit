import { afterAll, describe, expect, it } from "vitest";
import { chat, toolDefinition } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { z } from "zod";
import { Ratelimit } from "@upstash/agentkit-sdk";
import { rateLimit, toolCache } from "./middleware.js";
import { scriptedAdapter } from "../testing/test-adapter.js";
import {
  cleanupKeys,
  hasRedisCreds,
  testRedis,
  uniquePrefix,
  uniqueUserId,
} from "../testing/test-support.js";

async function drain(stream: unknown): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of stream as AsyncIterable<StreamChunk>) out.push(c);
  return out;
}

describe.skipIf(!hasRedisCreds)("toolCache middleware (live Redis, real chat loop)", () => {
  const redis = testRedis();
  const prefix = uniquePrefix("tstc");
  afterAll(async () => {
    await cleanupKeys(redis, prefix);
  });

  function setup(result: () => unknown) {
    const counter = { weather: 0, email: 0 };
    const weather = toolDefinition({
      name: "get_weather",
      description: "weather",
      inputSchema: z.object({ city: z.string() }),
    }).server(async ({ city }) => {
      counter.weather++;
      return { city, ...(result() as object) };
    });
    const email = toolDefinition({
      name: "send_email",
      description: "email",
      inputSchema: z.object({ to: z.string() }),
    }).server(async () => {
      counter.email++;
      return { sent: true };
    });
    return { counter, tools: [weather, email] };
  }

  const turns = (city: string) => [
    {
      toolCalls: [
        { id: `w-${city}-${Math.random()}`, name: "get_weather", args: { city } },
        { id: `e-${Math.random()}`, name: "send_email", args: { to: "a@b.c" } },
      ],
    },
    { text: "done" },
  ];

  it("serves a repeated call from Redis and skips the tool; never caches tools not allowlisted", async () => {
    const { counter, tools } = setup(() => ({ temp: 21 }));
    const userId = uniqueUserId("tc");
    const mw = toolCache({ tools: ["get_weather"], userId, redis, prefix });
    const messages = [{ role: "user" as const, content: "weather + email" }];

    await drain(
      chat({
        adapter: scriptedAdapter(turns("Paris")) as never,
        messages,
        tools,
        middleware: [mw],
      }),
    );
    const second = scriptedAdapter(turns("Paris"));
    await drain(chat({ adapter: second as never, messages, tools, middleware: [mw] }));

    expect(counter.weather).toBe(1); // second run was a cache hit
    expect(counter.email).toBe(2); // not allowlisted: always runs
    // The model still received the cached result as the tool's output.
    const toolMsg = (second.calls[1]!.messages as { role: string; content: string }[]).find(
      (m) => m.role === "tool" && m.content.includes("Paris"),
    );
    expect(JSON.parse(toolMsg!.content)).toEqual({ city: "Paris", temp: 21 });
  });

  it("keys by arguments and by user", async () => {
    const { counter, tools } = setup(() => ({ temp: 1 }));
    const messages = [{ role: "user" as const, content: "w" }];
    const run = (userId: string, city: string) =>
      drain(
        chat({
          adapter: scriptedAdapter(turns(city)) as never,
          messages,
          tools,
          middleware: [toolCache({ tools: ["get_weather"], userId, redis, prefix })],
        }),
      );
    const alice = uniqueUserId("alice");
    await run(alice, "Rome");
    await run(alice, "Oslo");
    await run(uniqueUserId("bob"), "Rome");
    await run(alice, "Rome");
    expect(counter.weather).toBe(3);
  });

  it("does not cache a failed call", async () => {
    let fail = true;
    let runs = 0;
    const flaky = toolDefinition({
      name: "get_weather",
      description: "w",
      inputSchema: z.object({ city: z.string() }),
    }).server(async () => {
      runs++;
      if (fail) throw new Error("upstream down");
      return { ok: true };
    });
    const mw = toolCache({ tools: ["get_weather"], userId: uniqueUserId("f"), redis, prefix });
    const script = () =>
      scriptedAdapter([
        { toolCalls: [{ id: `f-${Math.random()}`, name: "get_weather", args: { city: "X" } }] },
        { text: "ok" },
      ]);
    const messages = [{ role: "user" as const, content: "w" }];
    await drain(chat({ adapter: script() as never, messages, tools: [flaky], middleware: [mw] }));
    fail = false;
    await drain(chat({ adapter: script() as never, messages, tools: [flaky], middleware: [mw] }));
    await drain(chat({ adapter: script() as never, messages, tools: [flaky], middleware: [mw] }));
    expect(runs).toBe(2); // failure, then a real success, then a hit
  });
});

describe.skipIf(!hasRedisCreds)("rateLimit middleware (live Redis, real chat loop)", () => {
  const redis = testRedis();
  const prefix = uniquePrefix("tsrl");
  afterAll(async () => {
    await cleanupKeys(redis, prefix);
  });

  it("lets runs through up to the limit, then fails the run before the model is called", async () => {
    const identifier = uniqueUserId("rl");
    const mw = rateLimit({ redis, prefix, limiter: Ratelimit.fixedWindow(2, "60 s"), identifier });
    const messages = [{ role: "user" as const, content: "hi" }];
    const adapters = [1, 2, 3].map(() => scriptedAdapter([{ text: "hello" }]));
    const outcomes: string[] = [];
    for (const adapter of adapters) {
      try {
        const chunks = await drain(chat({ adapter: adapter as never, messages, middleware: [mw] }));
        const err = chunks.find((c) => (c as { type: string }).type === "RUN_ERROR");
        outcomes.push(err ? `error:${(err as { message?: string }).message}` : "ok");
      } catch (error) {
        outcomes.push(`threw:${(error as Error).name}`);
      }
    }
    expect(outcomes.slice(0, 2)).toEqual(["ok", "ok"]);
    expect(outcomes[2]).toMatch(/Rate limit exceeded|RateLimitExceededError/);
    expect(adapters[2]!.calls).toHaveLength(0); // the model was never called
  });
});
