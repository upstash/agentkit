import { NextResponse } from "next/server";
import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs, tool } from "ai";
import { s } from "@upstash/redis";
import { z } from "zod";
import {
  cachedTools,
  createMemoryTools,
  createRateLimit,
  createSearchTools,
} from "@upstash/agentkit-ai-sdk";
import { getRedis } from "../../lib/redis";

export const runtime = "nodejs";

// READMEs/demos use gpt-5.4-mini (unit tests use gpt-4o).
const DEMO_MODEL = "gpt-5.4-mini";

// A schema-driven Redis Search index the agent can query with the `search`/`aggregate`/`count` tools.
const bookSchema = s.object({
  title: s.string(),
  author: s.string().noTokenize(),
  year: s.number(),
});

export async function POST(req: Request) {
  try {
    const { input } = (await req.json()) as { input: string };
    const redis = getRedis();

    // Agent memory tools — recall_memory / save_memory, scoped per user via `namespace`.
    const memoryTools = createMemoryTools({ redis, namespace: "demo-user" });

    // Schema-driven search tools — search / aggregate / count over the books index.
    const searchTools = createSearchTools({ schema: bookSchema, redis, name: "demo:aisdk:books" });

    // Tool cache — deterministic tools whose results are memoized in Redis (cached under their map key).
    const cachedToolSet = cachedTools(
      {
        convert_price: tool({
          description: "Convert a USD price to another currency at today's rate.",
          inputSchema: z.object({ usd: z.number(), currency: z.string() }),
          execute: async ({ usd, currency }) => ({ usd, currency, amount: usd * 0.92 }),
        }),
      },
      { redis },
    );

    // Rate limiting — check an Upstash Ratelimit (by user) before doing any model work.
    const ratelimit = createRateLimit({
      redis, // the Upstash Redis client backing the limiter
      limit: 30, // optional: requests allowed per window (default 10)
      window: "1 m", // optional: sliding-window duration (default "60 s")
      // namespace: "agentkit:rateLimit", // optional: key prefix; keys are `<namespace>:<identifier>`
    });
    const { success } = await ratelimit.limit("demo-user");
    if (!success) {
      return NextResponse.json({ error: "rate limited" }, { status: 429 });
    }

    const model = openai(DEMO_MODEL);
    const tools = { ...memoryTools, ...searchTools, ...cachedToolSet };
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
