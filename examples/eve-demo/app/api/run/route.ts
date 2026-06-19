import { NextResponse } from "next/server";
import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import { z } from "zod";
import { defineCachedTool, defineMemoryRecallTool, defineMemorySaveTool } from "@upstash/agentkit-eve";
import { cachedModel } from "@upstash/agentkit-eve/model";
import { getRedis } from "../../lib/redis";

export const runtime = "nodejs";

// Per the demo convention, use gpt-5.4-mini here (tests use gpt-4o-mini).
const DEMO_MODEL = "gpt-5.4-mini";

// Eve passes a rich ToolContext at runtime; this route calls execute directly with a stub.
const CTX = {} as never;

export async function POST(req: Request) {
  try {
    const { input } = (await req.json()) as { input: string };
    const redis = getRedis();
    const save = defineMemorySaveTool({ redis, scope: "demo" });
    const recall = defineMemoryRecallTool({ redis, scope: "demo" });

    // "remember …" -> save a memory (the save_memory tool).
    if (/^remember\b/i.test(input.trim())) {
      const fact = input.trim().replace(/^remember\s+(that\s+)?/i, "");
      const saved = await save.execute({ text: fact }, CTX);
      return NextResponse.json({ saved });
    }

    // default: recall memory, run a cached tool, and answer with a cached model.
    const recalled = await recall.execute({ query: input }, CTX);

    const charCount = defineCachedTool({
      description: "Counts characters",
      inputSchema: z.object({ text: z.string() }),
      cachePrefix: "char_count",
      execute: ({ text }) => text.length,
      redis,
    });
    const length = await charCount.execute({ text: input }, CTX);

    const model = cachedModel({ model: openai(DEMO_MODEL), redis, namespace: "demo:eve:cache" });
    const result = await generateText({ model, prompt: input });

    return NextResponse.json({ recalled, length, text: result.text });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
