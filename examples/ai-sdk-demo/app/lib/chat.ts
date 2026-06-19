import { s } from "@upstash/redis";
import { createChatHistory } from "@upstash/agentkit-ai-sdk";
import { getRedis } from "./redis";

// A single hardcoded demo user — every chat is scoped to this owner.
export const USER = "demo-user";

// READMEs/demos use gpt-5.4-mini (unit tests use gpt-4o).
export const DEMO_MODEL = "gpt-5.4-mini";

// A schema-driven Redis Search index the agent can query with the `search`/`aggregate`/`count` tools.
export const bookSchema = s.object({
  title: s.string(),
  author: s.string().noTokenize(),
  year: s.number(),
});

export const BOOKS_INDEX = "demo:aisdk:books";

// Durable chat history backed by Upstash Redis Search — the source of truth for every conversation.
let history: ReturnType<typeof createChatHistory> | undefined;
export function getHistory() {
  return (history ??= createChatHistory({
    redis: getRedis(), // optional: defaults to Redis.fromEnv()
    namespace: "demo:aisdk:chat", // optional: key prefix + index name base (default "agentkit:chat")
    // ttlSeconds: 60 * 60 * 24, // optional: per-chat expiry; omitted here so chats persist
  }));
}
