import { NextResponse } from "next/server";
import { AgentMemory, SemanticCache } from "@upstash/agentkit-sdk";
import { withAgentKit, withSemanticCacheText, type EveTool } from "@upstash/agentkit-eve";
import { generate, getRedis, modelCalls, singleton } from "../../lib/agentkit";

export const runtime = "nodejs";

const mem = () =>
  singleton("eve:mem", () => new AgentMemory({ redis: getRedis(), namespace: "demo:eve:mem" }));
const semcache = () =>
  singleton(
    "eve:cache",
    () => new SemanticCache({ redis: getRedis(), namespace: "demo:eve:cache", minScore: 0.5 }),
  );

export async function POST(req: Request) {
  try {
    const { input, sessionId = "default" } = (await req.json()) as {
      input: string;
      sessionId?: string;
    };
    const steps: { label: string; detail: string }[] = [];

    const tools: EveTool[] = [
      {
        name: "add",
        description: "Adds two numbers",
        execute: async (args) => {
          const { a, b } = args as { a: number; b: number };
          return a + b;
        },
      },
    ];

    const aug = await withAgentKit(
      { instructions: "You are a concise assistant.", tools },
      {
        redis: getRedis(),
        memory: mem(),
        sessionId,
        scope: sessionId,
        useMemory: true,
        context: input,
        topK: 3,
      },
    );

    if (/^remember\b/i.test(input.trim())) {
      const fact = input.trim().replace(/^remember\s+(that\s+)?/i, "");
      await aug.memory?.remember(fact);
      await mem().searchIndex.waitIndexing();
      return NextResponse.json({
        ok: true,
        summary: `Stored a memory for "${sessionId}".`,
        steps: [{ label: "withAgentKit → memory.remember", detail: fact }],
      });
    }

    const augmented = aug.agent.instructions ?? "";
    steps.push({
      label: "withAgentKit (instructions)",
      detail:
        augmented.trim() === "You are a concise assistant."
          ? "no memory recalled — base instructions unchanged"
          : `augmented with recalled memory:\n${augmented}`,
    });

    const addTool = aug.agent.tools?.[0];
    if (addTool) {
      await addTool.execute({ a: 2, b: 3 });
      const sum = await addTool.execute({ a: 2, b: 3 });
      steps.push({
        label: "withAgentKit (cached tool) ×2",
        detail: `add(2, 3) = ${sum} — 2nd call from ToolCache`,
      });
    }

    const cachedGenerate = withSemanticCacheText(generate, { cache: semcache() });
    const before = modelCalls();
    const response = await aug.trace("eve.run", () => cachedGenerate(input));
    const cacheHit = modelCalls() === before;
    // Demo: block until indexed so an immediate repeat shows a cache hit.
    if (!cacheHit) await semcache().searchIndex.waitIndexing();
    steps.push({
      label: "aug.trace + withSemanticCacheText",
      detail: cacheHit
        ? "cache HIT — model not called (run traced via Telemetry)"
        : "cache miss — model generated (run traced via Telemetry)",
    });

    await aug.history?.append([
      { role: "user", content: input },
      { role: "assistant", content: response },
    ]);
    steps.push({ label: "withAgentKit → history.append", detail: "persisted user + assistant turn" });

    return NextResponse.json({
      ok: true,
      summary: response,
      steps,
      data: { cacheHit, instructions: augmented },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
