import { NextResponse } from "next/server";
import { AgentMemory, ChatHistory, Sandbox, SemanticCache } from "@upstash/agentkit-sdk";
import {
  createHistoryStore,
  sandboxedTool,
  withMemory,
  withSemanticCacheText,
} from "@upstash/agentkit-ai-sdk";
import { embedder, generate, modelCalls, redis, toolCache, vector } from "../../lib/agentkit";

export const runtime = "nodejs";

const history = new ChatHistory({ redis, namespace: "demo:aisdk:chat" });
const store = createHistoryStore({ history });
const cache = new SemanticCache({ vector, embedder, namespace: "demo:aisdk:cache", minScore: 0.8 });
const memory = new AgentMemory({ vector, redis, embedder, namespace: "demo:aisdk:mem" });

export async function POST(req: Request) {
  try {
    const { input, sessionId = "default" } = (await req.json()) as {
      input: string;
      sessionId?: string;
    };
    const steps: { label: string; detail: string }[] = [];

    if (/^remember\b/i.test(input.trim())) {
      const fact = input.trim().replace(/^remember\s+(that\s+)?/i, "");
      await memory.add(fact, { scope: sessionId });
      return NextResponse.json({
        ok: true,
        summary: `Stored a memory for "${sessionId}".`,
        steps: [{ label: "AgentMemory.add", detail: fact }],
      });
    }

    // Load prior turns as AI-SDK CoreMessages.
    const prior = await store.load(sessionId, { limit: 6 });
    steps.push({ label: "createHistoryStore().load", detail: `${prior.length} CoreMessage(s)` });

    // Inject relevant long-term memories as a system message.
    const injector = withMemory({ memory, scope: sessionId, topK: 3 });
    const messages = await injector.inject(input, [...prior, { role: "user", content: input }]);
    const injected = messages.length > prior.length + 1;
    steps.push({
      label: "withMemory().inject",
      detail: injected ? "prepended a memory system message" : "no relevant memories to inject",
    });

    // Run a sandboxed AI-SDK tool (word counter) — hardened with timeout/retry + cache.
    const sandbox = new Sandbox({ timeoutMs: 3000, toolCache });
    const wordCount = sandboxedTool<{ text: string }, number>(
      "wordCount",
      {
        description: "Counts the words in a string",
        execute: async ({ text }) => text.trim().split(/\s+/).filter(Boolean).length,
      },
      sandbox,
    );
    const count = await wordCount.execute!({ text: input }, {});
    steps.push({ label: "sandboxedTool(wordCount)", detail: `input has ${count} word(s)` });

    // Semantic-cached generation over the flattened messages.
    const prompt = messages
      .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
      .join("\n");
    const cachedGenerate = withSemanticCacheText(generate, { cache });
    const before = modelCalls();
    const response = await cachedGenerate(prompt);
    const cacheHit = modelCalls() === before;
    steps.push({
      label: "withSemanticCacheText(model)",
      detail: cacheHit ? "cache HIT — model not called" : "cache miss — model generated a response",
    });

    // Persist both sides in CoreMessage form.
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
