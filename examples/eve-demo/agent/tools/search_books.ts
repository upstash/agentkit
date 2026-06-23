import { defineSearchTools } from "@upstash/agentkit-eve";
import { s } from "@upstash/redis";

// Self-contained: eve's per-tool snapshot doesn't include shared agent-source modules, so each book
// tool repeats the schema + index name (keep them in sync with the other book tools + lib/books.ts).
// `defineSearchTools` returns { search, aggregate, count }; this file exposes `search`. The index is
// created reactively on first use; `redis` defaults to Redis.fromEnv() inside the package.
export default defineSearchTools({
  schema: s.object({ title: s.string(), author: s.string().noTokenize(), year: s.number() }),
  indexName: "eve-demo-books",
}).search;
