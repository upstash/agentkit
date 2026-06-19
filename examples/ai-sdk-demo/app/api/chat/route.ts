import { openai } from "@ai-sdk/openai";
import { convertToModelMessages, streamText, stepCountIs, tool, type UIMessage } from "ai";
import { z } from "zod";
import {
  cachedTools,
  createMemoryTools,
  createRateLimit,
  createSearchTools,
} from "@upstash/agentkit-ai-sdk";
import { getRedis } from "../../lib/redis";
import { BOOKS_INDEX, DEMO_MODEL, USER, bookSchema, getHistory } from "../../lib/chat";

export const runtime = "nodejs";

export async function POST(req: Request) {
  // The client (`useChat` with the default transport) posts the WHOLE messages array + the chat id.
  const { id, messages } = (await req.json()) as { id: string; messages: UIMessage[] };
  const redis = getRedis();

  // Rate limiting — check an Upstash Ratelimit (by user) before doing any model work.
  const ratelimit = createRateLimit({
    redis, // the Upstash Redis client backing the limiter
    limit: 30, // optional: requests allowed per window (default 10)
    window: "1 m", // optional: sliding-window duration (default "60 s")
    // namespace: "agentkit:rateLimit", // optional: key prefix; keys are `<namespace>:<identifier>`
  });
  const { success } = await ratelimit.limit(USER);
  if (!success) {
    return new Response("Rate limited", { status: 429 });
  }

  // Agent memory tools — recall_memory / save_memory, scoped per user via `namespace`.
  const memoryTools = createMemoryTools({ redis, namespace: USER });

  // Schema-driven search tools — search / aggregate / count over the books index (created reactively).
  const searchTools = createSearchTools({ schema: bookSchema, redis, name: BOOKS_INDEX });

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

  const model = openai(DEMO_MODEL);
  const tools = { ...memoryTools, ...searchTools, ...cachedToolSet };

  const result = streamText({
    model,
    messages: await convertToModelMessages(messages),
    tools,
    stopWhen: stepCountIs(5),
  });

  const history = getHistory();
  const firstUserText = messages
    .find((m) => m.role === "user")
    ?.parts.map((p) => (p.type === "text" ? p.text : ""))
    .join(" ")
    .trim();

  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    // Persist the WHOLE conversation (including the new assistant reply) when the stream finishes.
    onFinish: async ({ messages }) => {
      await history.saveChat(USER, id, messages, {
        title: firstUserText ? firstUserText.slice(0, 60) : "New chat",
      });
    },
  });
}
