import { generateText, isStepCount, tool, ToolLoopAgent, type ModelMessage } from "ai";
import { z } from "zod";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4GenerateResult, LanguageModelV4Prompt } from "@ai-sdk/provider";
import { Redis } from "@upstash/redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentMemory } from "./agent-memory.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniqueUserId } from "./test-support.js";

/** Poll a read until it reflects a just-written doc — insurance for residual indexing lag. */
async function pollUntil<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8_000;
  let value = await read();
  while (!ready(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    value = await read();
  }
  return value;
}

const TOOL_OPTS = { toolCallId: "t", messages: [] } as never;
function call<R>(execute: unknown, input: unknown): Promise<R> {
  return (execute as (i: unknown, o: unknown) => Promise<R>)(input, TOOL_OPTS);
}

const RESULT: LanguageModelV4GenerateResult = {
  content: [{ type: "text", text: "ok" }],
  finishReason: { unified: "stop", raw: undefined },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  },
  warnings: [],
};

/** The system text the mocked model received on its first call. */
function systemText(prompt: LanguageModelV4Prompt): string {
  return prompt
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
}

describe("createAgentMemory (no Redis)", () => {
  // A client for an unreachable host: none of these cases ever sends a request.
  const memory = createAgentMemory({
    redis: new Redis({ url: "https://unreachable.invalid", token: "unused" }),
    recallToolName: "remember_what",
    saveToolName: "note_down",
  });

  it("names the configured tools in its instructions and tool map", () => {
    expect(memory.instructions).toContain("`remember_what`");
    expect(memory.instructions).toContain("`note_down`");
    expect(Object.keys(memory.tools({ userId: "u" })).sort()).toEqual([
      "note_down",
      "remember_what",
    ]);
  });

  it("swallows a failed recall and reports it to onError", async () => {
    const errors: unknown[] = [];
    const model = new MockLanguageModelV4({ doGenerate: RESULT });
    const result = await generateText({
      model,
      instructions: "base",
      prompt: "hi",
      // ':' is rejected by the core userId validation before any Redis call.
      prepareStep: memory.prepareStep({ userId: "bad:id", onError: (e) => errors.push(e) }),
    });
    expect(result.text).toBe("ok");
    expect(errors).toHaveLength(1);
    expect(systemText(model.doGenerateCalls[0]!.prompt)).toBe("base");
  });
});

describe.skipIf(!hasRedisCreds)("createAgentMemory (live Redis)", () => {
  const redis = testRedis();
  const userId = uniqueUserId("aisdk-provider");
  const emptyUser = uniqueUserId("aisdk-provider-empty");
  const memory = createAgentMemory({ redis });

  // Provision the index before seeding: waitIndexing() on a missing index is a silent no-op.
  beforeAll(async () => {
    await memory.store.recall({ userId, query: "provisioning probe" });
    await memory.store.add({ userId, text: "The user's favorite editor is Neovim" });
    await memory.store.add({ userId, text: "The user lives in Lisbon" });
    await memory.store.searchIndex.waitIndexing();
    await pollUntil(
      () => memory.store.list({ userId }),
      (all) => all.length >= 2,
    );
  });

  afterAll(async () => {
    await cleanupKeys(redis, `agentkit:memory:${userId}`);
  });

  it("tools() saves and recalls through the shared store", async () => {
    const tools = memory.tools({ userId });
    const recalled = await pollUntil(
      () => call<{ text: string }[]>(tools.recall_memory!.execute, { query: "editor" }),
      (hits) => hits.some((h) => h.text.includes("Neovim")),
    );
    expect(recalled.some((h) => h.text.includes("Neovim"))).toBe(true);
  });

  it("prepareStep appends relevant memories to string instructions on step 0 only", async () => {
    await pollUntil(
      () => memory.store.recall({ userId, query: "Which editor do I use?" }),
      (hits) => hits.some((h) => h.text.includes("Neovim")),
    );
    // Step 0 calls a tool, step 1 answers: the block is injected once and carries forward.
    const toolCall: LanguageModelV4GenerateResult = {
      ...RESULT,
      content: [{ type: "tool-call", toolCallId: "c1", toolName: "ping", input: "{}" }],
      finishReason: { unified: "tool-calls", raw: undefined },
    };
    const twoStep = new MockLanguageModelV4({ doGenerate: [toolCall, RESULT] });
    await generateText({
      model: twoStep,
      instructions: "You are helpful.",
      prompt: "Which editor do I use?",
      tools: { ping: tool({ inputSchema: z.object({}), execute: async () => "pong" }) },
      stopWhen: isStepCount(3),
      prepareStep: memory.prepareStep({ userId }),
    });
    expect(twoStep.doGenerateCalls).toHaveLength(2);
    const system = systemText(twoStep.doGenerateCalls[0]!.prompt);
    expect(system.startsWith("You are helpful.\n\n<memories>")).toBe(true);
    expect(system).toContain("Neovim");
    expect(systemText(twoStep.doGenerateCalls[1]!.prompt)).toBe(system);
    expect(system.match(/<memories>/g)).toHaveLength(1);
  });

  it("works on a shared ToolLoopAgent with userId from runtimeContext and a custom query", async () => {
    const model = new MockLanguageModelV4({ doGenerate: RESULT });
    const queries: string[] = [];
    const agent = new ToolLoopAgent({
      model,
      runtimeContext: { userId },
      prepareStep: memory.prepareStep({
        userId: ({ runtimeContext }) => runtimeContext.userId,
        query: (messages: ModelMessage[]) => {
          queries.push(String(messages.at(-1)?.content));
          return "Lisbon";
        },
      }),
    });
    await pollUntil(
      () => memory.store.recall({ userId, query: "Lisbon" }),
      (hits) => hits.some((h) => h.text.includes("Lisbon")),
    );
    await agent.generate({ prompt: "Where do I live?" });
    expect(queries).toEqual(["Where do I live?"]);
    const system = systemText(model.doGenerateCalls[0]!.prompt);
    expect(system).toMatch(/^<memories>/);
    expect(system).toContain("Lisbon");
  });

  it("falls back to all memories when the query matches none", async () => {
    const model = new MockLanguageModelV4({ doGenerate: RESULT });
    await generateText({
      model,
      prompt: "Recommend dinner tonight",
      prepareStep: memory.prepareStep({ userId }),
    });
    const system = systemText(model.doGenerateCalls[0]!.prompt);
    expect(system).toContain("Neovim");
    expect(system).toContain("Lisbon");
  });

  it("leaves instructions untouched when nothing is recalled", async () => {
    const model = new MockLanguageModelV4({ doGenerate: RESULT });
    await generateText({
      model,
      instructions: "base",
      prompt: "hello",
      prepareStep: memory.prepareStep({ userId: emptyUser }),
    });
    expect(systemText(model.doGenerateCalls[0]!.prompt)).toBe("base");
  });
});
