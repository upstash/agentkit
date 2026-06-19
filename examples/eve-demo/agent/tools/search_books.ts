import { bookSearch } from "../lib/book-search.js";

// Fuzzy ($smart / BM25) text search + filters over the books index. The tool set
// is built once in agent/lib/book-search.ts; this file just re-exports the
// `search` member so eve registers it as the `search_books` tool (filename = name).
// It's already `defineTool`-branded, so export it directly.
export default bookSearch.search;
