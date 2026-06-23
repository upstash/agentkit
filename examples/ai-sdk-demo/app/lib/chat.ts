import { s } from "@upstash/redis";
import { createChatHistory } from "@upstash/agentkit-ai-sdk";
import { getRedis } from "./redis";

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
    prefix: "demo:aisdk:chat", // optional: base key prefix + index name base (default "agentkit:chat")
    // ttlSeconds: 60 * 60 * 24, // optional: per-chat expiry; omitted here so chats persist
  }));
}

// Demo books for the search tools to query (so `search`/`aggregate`/`count` return real results).
const BOOKS = [
  { id: "1", title: "The Left Hand of Darkness", author: "Ursula K. Le Guin", year: 1969 },
  { id: "2", title: "The Dispossessed", author: "Ursula K. Le Guin", year: 1974 },
  { id: "3", title: "A Wizard of Earthsea", author: "Ursula K. Le Guin", year: 1968 },
  { id: "4", title: "Neuromancer", author: "William Gibson", year: 1984 },
  { id: "5", title: "Dune", author: "Frank Herbert", year: 1965 },
  { id: "6", title: "Foundation", author: "Isaac Asimov", year: 1951 },
  { id: "7", title: "Snow Crash", author: "Neal Stephenson", year: 1992 },
  { id: "8", title: "The Three-Body Problem", author: "Liu Cixin", year: 2008 },
];

/**
 * Seed the books index once. A boolean flag key in Redis gates it: unset/false → write the docs,
 * build the index, and set the flag; true → no-op. Call this before rendering so the agent's first
 * `search`/`count` returns data.
 */
export async function seedBooks(): Promise<void> {
  const redis = getRedis();
  const flagKey = `${BOOKS_INDEX}:seeded`;
  if (await redis.get(flagKey)) return; // already seeded — no-op

  const prefix = `${BOOKS_INDEX}:`;
  await Promise.all(
    BOOKS.map((b) =>
      redis.json.set(prefix + b.id, "$", { title: b.title, author: b.author, year: b.year }),
    ),
  );
  // Create the index + wait so the very first query returns the seeded rows.
  await redis.search
    .createIndex({ name: BOOKS_INDEX, dataType: "json", prefix, schema: bookSchema })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already exists/i.test(msg)) throw err;
    });
  await redis.search.index({ name: BOOKS_INDEX, schema: bookSchema }).waitIndexing();
  await redis.set(flagKey, true);
}
