import { defineSearchTools } from "@upstash/agentkit-eve";
import { s } from "@upstash/redis";

// Count of books matching a filter over the books index. Self-contained — see the note in
// search_books.ts; the schema + name must match the other book tools and lib/books.ts (the seed).
export default defineSearchTools({
  schema: s.object({ title: s.string(), author: s.string().noTokenize(), year: s.number() }),
  indexName: "eve-demo-books",
}).count;
