import { openai } from "@ai-sdk/openai";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  streamText,
  stepCountIs,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { z } from "zod";
import {
  cachedTool,
  createMemoryTools,
  createRateLimit,
  createSearchTools,
} from "@upstash/agentkit-ai-sdk";
import { getRedis } from "../../lib/redis";
import { BOOKS_INDEX, DEMO_MODEL, bookSchema, getHistory } from "../../lib/chat";
import { USER_HEADER, normalizeUser } from "../../lib/users";

export const runtime = "nodejs";

export async function POST(req: Request) {
  // The client (`useChat`) posts the WHOLE messages array + the chat id, and sends the active user id
  // as a header. Memory, history, tool cache and rate limit are all scoped to this user; only the
  // shared books index is common to everyone.
  const { id, messages } = (await req.json()) as { id: string; messages: UIMessage[] };
  const userId = normalizeUser(req.headers.get(USER_HEADER));
  const redis = getRedis();

  // Rate limiting — limit per user (the identifier), before doing any model work.
  const ratelimit = createRateLimit({
    redis, // the Upstash Redis client backing the limiter
    limit: 30, // optional: requests allowed per window (default 10)
    window: "1 m", // optional: sliding-window duration (default "60 s")
    // prefix: "agentkit:rateLimit", // optional: base key prefix; keys are `<prefix>:<identifier>`
  });
  const { success } = await ratelimit.limit(userId); // per-user identifier
  if (!success) {
    return new Response("Rate limited", { status: 429 });
  }

  // Agent memory tools — recall_memory / save_memory, scoped to this user via `namespace`.
  const memoryTools = createMemoryTools({ redis, namespace: userId });

  // Schema-driven search tools — search / aggregate / count over the books index (created reactively).
  // The books index is intentionally SHARED across users, so no per-user namespace here.
  const searchTools = createSearchTools({ schema: bookSchema, redis, indexName: BOOKS_INDEX });

  // Tool cache — deterministic tool results memoized in Redis, scoped per user via the namespace.
  const cachedToolSet = {
    convert_price: cachedTool({
      description: "Convert a USD price to another currency at today's rate.",
      inputSchema: z.object({ usd: z.number(), currency: z.string() }),
      namespace: `${userId}:convert_price`, // per-user cache key
      redis,
      execute: async ({ usd, currency }) => ({ usd, currency, amount: usd * 0.92 }),
    }),
  };

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

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      originalMessages: messages,
      // Persist the WHOLE conversation (including the new assistant reply) when the stream finishes.
      onFinish: async ({ messages }) => {
        await history.saveChat({
          userId,
          sessionId: id,
          messages,
          title: firstUserText ? firstUserText.slice(0, 60) : "New chat",
        });
      },
    }),
  });
}
