import { s } from "@upstash/redis";
import { defineSearchTools } from "@upstash/agentkit-eve";

import { redis } from "../redis.js";

// eve is file-centric (one tool per file, filename = tool name), so the search
// tool *set* is built ONCE here over a single Upstash Redis Search index, then
// each member is re-exported from its own file under agent/tools/. The index is
// created reactively on first use (no ensureIndex / setup step).
//
// The schema describes the documents in the "eve-demo-books" index. `author` is
// `.noTokenize()` so it's an exact filter/tag field, while `title` is tokenized
// for fuzzy ($smart, BM25) text matching and `year` is numeric (range filters).
export const bookSearch = defineSearchTools({
  schema: s.object({
    title: s.string(),
    author: s.string().noTokenize(),
    year: s.number(),
  }),
  name: "eve-demo-books", // index name — also the basis for the doc-key prefix
  redis, // optional: Upstash client; defaults to Redis.fromEnv()
  // optional: prefix (doc-key prefix), defaultLimit (page size for `search`)
});
