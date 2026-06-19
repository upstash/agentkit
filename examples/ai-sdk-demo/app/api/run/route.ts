import { NextResponse } from "next/server";
import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs } from "ai";
import { s } from "@upstash/redis";
import {
  createMemoryTools,
  createSearchTools,
  rateLimitedModel,
  cachedModel,
} from "@upstash/agentkit-ai-sdk";
import { getRedis } from "../../lib/redis";

export const runtime = "nodejs";

// Per the demo convention, use gpt-5.4-mini here (tests use gpt-4o-mini).
const DEMO_MODEL = "gpt-5.4-mini";

const bookSchema = s.object({
  title: s.string(),
  author: s.string().noTokenize(),
  year: s.number(),
});

export async function POST(req: Request) {
  try {
    const { input } = (await req.json()) as { input: string };
    const redis = getRedis();

    // A cached, rate-limited model.
    const model = rateLimitedModel({
      model: cachedModel({ model: openai(DEMO_MODEL), redis, namespace: "demo:aisdk:cache" }),
      redis,
      limit: 30,
      window: "1 m",
    });

    // Memory tools + schema-driven search tools, all available to the agent.
    const tools = {
      ...createMemoryTools({ redis, scope: "demo" }),
      ...createSearchTools({ schema: bookSchema, redis, name: "demo:aisdk:books" }),
    };

    const result = await generateText({ model, tools, stopWhen: stepCountIs(5), prompt: input });

    return NextResponse.json({
      text: result.text,
      steps: result.steps.length,
      toolCalls: result.toolCalls.map((t) => t.toolName),
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
