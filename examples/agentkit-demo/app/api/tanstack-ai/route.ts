import { NextResponse } from "next/server";
import { ChatHistory, SemanticCache, ToolCache } from "@upstash/agentkit-sdk";
import {
  createChatHandler,
  withSemanticCache,
  wrapTool,
  type ChatGenerate,
} from "@upstash/agentkit-tanstack-ai";
import { generate, modelCalls, redis, searchStore } from "../../lib/agentkit";

export const runtime = "nodejs";

const history = new ChatHistory({ redis, namespace: "demo:tanstack:chat" });
const cache = new SemanticCache({ search: searchStore("tanstack:cache"), minScore: 0.8 });
const toolCache = new ToolCache({ redis, namespace: "demo:tanstack:tool" });

// A cached tool: identical inputs are memoized via ToolCache.
const reverse = wrapTool(
  {
    name: "reverse",
    description: "Reverses a string",
    execute: ({ text }: { text: string }) => [...text].reverse().join(""),
  },
  { toolCache },
);

// Cache the model call, keyed on the latest user message so unrelated turns don't collide.
const cachedGenerate = withSemanticCache(generate, { cache });

export async function POST(req: Request) {
  try {
    const { input, sessionId = "default" } = (await req.json()) as {
      input: string;
      sessionId?: string;
    };
    const steps: { label: string; detail: string }[] = [];

    const chatGenerate: ChatGenerate = async (messages) => {
      const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
      return cachedGenerate(lastUser);
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
