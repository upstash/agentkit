import { Redis, s } from "@upstash/redis";

// The demo books index name + schema. NOTE: eve's dev-runtime snapshot does not include shared
// agent-source modules, so the search tools under agent/tools/*.ts can't import this file — they
// repeat the same schema + name inline. Keep them in sync with the values here.
export const BOOKS_INDEX = "eve-demo-books";
export const bookSchema = s.object({
  title: s.string(),
  author: s.string().noTokenize(),
  year: s.number(),
});

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
 * build the index, set the flag; true → no-op. Called from the page (Next.js server), so `Redis`
 * is created lazily here — importing this module never touches env at build time.
 */
export async function seedBooks(): Promise<void> {
  const redis = Redis.fromEnv();
  const flagKey = `${BOOKS_INDEX}:seeded`;
  if (await redis.get(flagKey)) return; // already seeded — no-op

  const prefix = `${BOOKS_INDEX}:`;
  await Promise.all(
    BOOKS.map((b) =>
      redis.json.set(prefix + b.id, "$", { title: b.title, author: b.author, year: b.year }),
    ),
  );
  await redis.search
    .createIndex({ name: BOOKS_INDEX, dataType: "json", prefix, schema: bookSchema })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already exists/i.test(msg)) throw err;
    });
  await redis.search.index({ name: BOOKS_INDEX, schema: bookSchema }).waitIndexing();
  await redis.set(flagKey, true);
}
