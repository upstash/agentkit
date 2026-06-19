import { NextResponse } from "next/server";
import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import { AgentMemory, ToolCache } from "@upstash/agentkit-sdk";
import { cachedExecute, recallMemoryTool, saveMemoryTool } from "@upstash/agentkit-eve";
import { semanticCachedModel } from "@upstash/agentkit-eve/model";
import { upstash } from "@upstash/agentkit-eve/sandbox";
import { getRedis } from "../../lib/redis";

export const runtime = "nodejs";

// Per the demo convention, use gpt-5.4-mini here (tests use gpt-4o-mini).
const DEMO_MODEL = "gpt-5.4-mini";

export async function POST(req: Request) {
  try {
    const { input } = (await req.json()) as { input: string };
    const redis = getRedis();
    const memory = new AgentMemory({ redis, namespace: "demo:eve:mem" });
    const save = saveMemoryTool({ memory, scope: "demo" });
    const recall = recallMemoryTool({ memory, scope: "demo" });

    // "remember …" -> save a memory (the save_memory tool).
    if (/^remember\b/i.test(input.trim())) {
      const fact = input.trim().replace(/^remember\s+(that\s+)?/i, "");
      const saved = await save.execute({ text: fact });
      await memory.searchIndex.waitIndexing();
      return NextResponse.json({ saved });
    }

    // "box: <cmd>" -> run a command in a real Upstash Box sandbox.
    if (/^box:/i.test(input.trim())) {
      const command = input.trim().replace(/^box:\s*/i, "");
      const session = await upstash({ runtime: "node" }).createSession();
      try {
        const result = await session.run({ command });
        return NextResponse.json({ sandbox: { command, stdout: result.stdout, exitCode: result.exitCode } });
      } finally {
        await session.destroy();
      }
    }

    // default: recall memory, run a cached tool, and answer with a cached model.
    const recalled = await recall.execute({ query: input });
    const charCount = cachedExecute(
      "char_count",
      async ({ text }: { text: string }) => text.length,
      { toolCache: new ToolCache({ redis, namespace: "demo:eve:tool" }) },
    );
    const length = await charCount({ text: input });
    const model = semanticCachedModel({ model: openai(DEMO_MODEL), redis, namespace: "demo:eve:cache" });
    const result = await generateText({ model, prompt: input });

    return NextResponse.json({ recalled, length, text: result.text });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
