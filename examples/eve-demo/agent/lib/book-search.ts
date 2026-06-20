import { defineSearchTools } from "@upstash/agentkit-eve";

import { redis } from "../redis.js";
import { BOOKS_INDEX, bookSchema } from "./books.js";

// eve is file-centric (one tool per file, filename = tool name), so the search
// tool *set* is built ONCE here over a single Upstash Redis Search index, then
// each member is re-exported from its own file under agent/tools/. The index is
// created reactively on first use (no ensureIndex / setup step). The schema +
// index name live in ./books.ts, shared with the seeder that injects demo rows.
export const bookSearch = defineSearchTools({
  schema: bookSchema, // documents in the "eve-demo-books" index (title/author/year)
  name: BOOKS_INDEX, // index name — also the basis for the doc-key prefix
  redis, // optional: Upstash client; defaults to Redis.fromEnv()
  // optional: prefix (doc-key prefix), defaultLimit (page size for `search`)
});
