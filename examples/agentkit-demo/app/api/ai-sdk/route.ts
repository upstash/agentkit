import { NextResponse } from "next/server";
import { AgentMemory, ChatHistory, SemanticCache, ToolCache } from "@upstash/agentkit-sdk";
import { createHistoryStore, withMemory, wrapTool } from "@upstash/agentkit-ai-sdk";
import { generate, getRedis, modelCalls, singleton } from "../../lib/agentkit";

export const runtime = "nodejs";

const hist = () =>
  singleton("aisdk:chat", () => new ChatHistory({ redis: getRedis(), namespace: "demo:aisdk:chat" }));
const semcache = () =>
  singleton(
    "aisdk:cache",
    () => new SemanticCache({ redis: getRedis(), namespace: "demo:aisdk:cache", minScore: 0.5 }),
  );
const mem = () =>
  singleton("aisdk:mem", () => new AgentMemory({ redis: getRedis(), namespace: "demo:aisdk:mem" }));
const tools = () =>
  singleton("aisdk:tool", () => new ToolCache({ redis: getRedis(), namespace: "demo:aisdk:tool" }));

export async function POST(req: Request) {
  try {
    const { input, sessionId = "default" } = (await req.json()) as {
      input: string;
      sessionId?: string;
    };
    const steps: { label: string; detail: string }[] = [];

    if (/^remember\b/i.test(input.trim())) {
      const fact = input.trim().replace(/^remember\s+(that\s+)?/i, "");
      await mem().add(fact, { scope: sessionId });
      await mem().searchIndex.waitIndexing();
      return NextResponse.json({
        ok: true,
        summary: `Stored a memory for "${sessionId}".`,
        steps: [{ label: "AgentMemory.add", detail: fact }],
      });
    }

    const store = createHistoryStore({ history: hist() });
    const prior = await store.load(sessionId, { limit: 6 });
    steps.push({ label: "createHistoryStore().load", detail: `${prior.length} CoreMessage(s)` });

    const injector = withMemory({ memory: mem(), scope: sessionId, topK: 3 });
    const messages = await injector.inject(input, [...prior, { role: "user", content: input }]);
    steps.push({
      label: "withMemory().inject",
      detail: messages.length > prior.length + 1 ? "prepended a memory system message" : "no memories",
    });

    // Cache-memoized AI SDK tool (word counter).
    const wordCount = wrapTool<{ text: string }, number>(
      "wordCount",
      {
        description: "Counts the words in a string",
        execute: async ({ text }) => text.trim().split(/\s+/).filter(Boolean).length,
      },
      { toolCache: tools() },
    );
    const count = await wordCount.execute!({ text: input }, {});
    steps.push({ label: "wrapTool(wordCount)", detail: `input has ${count} word(s)` });

    const before = modelCalls();
    const hit = await semcache().get(input);
    let response: string;
    if (hit) {
      response = hit.response;
    } else {
      response = await generate(input);
      await semcache().set(input, response);
      await semcache().searchIndex.waitIndexing();
    }
    const cacheHit = modelCalls() === before;
    steps.push({
      label: "SemanticCache (keyed on question)",
      detail: cacheHit ? "cache HIT — model not called" : "cache miss — model generated",
    });

    await store.save(sessionId, [{ role: "user", content: input }]);
    await store.saveResult(sessionId, { text: response });

    return NextResponse.json({
      ok: true,
      summary: response,
      steps,
      data: { cacheHit, wordCount: count, coreMessages: messages },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
