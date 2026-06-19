import { NextResponse } from "next/server";
import { ChatHistory, SemanticCache, ToolCache } from "@upstash/agentkit-sdk";
import {
  createChatHandler,
  withSemanticCache,
  wrapTool,
  type ChatGenerate,
} from "@upstash/agentkit-tanstack-ai";
import { generate, getRedis, modelCalls, singleton } from "../../lib/agentkit";

export const runtime = "nodejs";

const hist = () =>
  singleton(
    "tanstack:chat",
    () => new ChatHistory({ redis: getRedis(), namespace: "demo:tanstack:chat" }),
  );
const semcache = () =>
  singleton(
    "tanstack:cache",
    () => new SemanticCache({ redis: getRedis(), namespace: "demo:tanstack:cache", minScore: 0.5 }),
  );
const tools = () =>
  singleton("tanstack:tool", () => new ToolCache({ redis: getRedis(), namespace: "demo:tanstack:tool" }));

export async function POST(req: Request) {
  try {
    const { input, sessionId = "default" } = (await req.json()) as {
      input: string;
      sessionId?: string;
    };
    const steps: { label: string; detail: string }[] = [];

    const cachedGenerate = withSemanticCache(generate, { cache: semcache() });
    const chatGenerate: ChatGenerate = async (messages) => {
      const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
      return cachedGenerate(lastUser);
    };
    const handler = createChatHandler({ history: hist(), generate: chatGenerate, limit: 6 });

    const before = modelCalls();
    const turn = await handler({ sessionId, message: input });
    const cacheHit = modelCalls() === before;
    // Demo: block until indexed so an immediate repeat shows a cache hit.
    if (!cacheHit) await semcache().searchIndex.waitIndexing();
    steps.push({
      label: "createChatHandler()",
      detail: `persisted user + assistant; conversation now ${turn.messages.length} message(s)`,
    });
    steps.push({
      label: "withSemanticCache(model)",
      detail: cacheHit ? "cache HIT — model not called" : "cache miss — model generated a reply",
    });

    const reverse = wrapTool(
      {
        name: "reverse",
        description: "Reverses a string",
        execute: ({ text }: { text: string }) => [...text].reverse().join(""),
      },
      { toolCache: tools() },
    );
    await reverse.execute({ text: input });
    const reversed = await reverse.execute({ text: input });
    steps.push({
      label: "wrapTool(reverse) ×2",
      detail: `reverse("${input}") = "${reversed}" (2nd call from ToolCache)`,
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
