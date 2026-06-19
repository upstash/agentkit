import { NextResponse } from "next/server";
import { ChatHistory, SemanticCache } from "@upstash/agentkit-sdk";
import {
  createChatHandler,
  withSemanticCache,
  wrapTool,
  type ChatGenerate,
} from "@upstash/agentkit-tanstack-ai";
import { embedder, generate, modelCalls, redis, toolCache, vector } from "../../lib/agentkit";

export const runtime = "nodejs";

const history = new ChatHistory({ redis, namespace: "demo:tanstack:chat" });
const cache = new SemanticCache({
  vector,
  embedder,
  namespace: "demo:tanstack:cache",
  minScore: 0.8,
});

// A cached tool: identical inputs are memoized via ToolCache.
const reverse = wrapTool(
  {
    name: "reverse",
    description: "Reverses a string",
    execute: ({ text }: { text: string }) => [...text].reverse().join(""),
  },
  { toolCache },
);

export async function POST(req: Request) {
  try {
    const { input, sessionId = "default" } = (await req.json()) as {
      input: string;
      sessionId?: string;
    };
    const steps: { label: string; detail: string }[] = [];

    // The model call is wrapped with a semantic cache.
    const cachedGenerate = withSemanticCache(generate, { cache });
    const chatGenerate: ChatGenerate = async (messages) => {
      const prompt = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
      return cachedGenerate(prompt);
    };

    const handler = createChatHandler({ history, generate: chatGenerate, limit: 6 });

    const before = modelCalls();
    const turn = await handler({ sessionId, message: input });
    const cacheHit = modelCalls() === before;
    steps.push({
      label: "createChatHandler()",
      detail: `persisted user + assistant; conversation now ${turn.messages.length} message(s)`,
    });
    steps.push({
      label: "withSemanticCache(model)",
      detail: cacheHit ? "cache HIT — model not called" : "cache miss — model generated a reply",
    });

    // Demonstrate the cached tool (call twice -> second is a cache hit).
    await reverse.execute({ text: input });
    const reversed = await reverse.execute({ text: input });
    steps.push({
      label: "wrapTool(reverse) ×2",
      detail: `reverse("${input}") = "${reversed}" (2nd call served from ToolCache)`,
    });

    return NextResponse.json({
      ok: true,
      summary: turn.message.content,
      steps,
      data: { cacheHit, conversation: turn.messages },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
