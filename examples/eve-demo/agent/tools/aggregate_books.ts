import { bookSearch } from "../lib/book-search.js";

// Aggregations over the books index ($terms, $stats, $histogram, …), e.g. count
// books per author or year buckets. Same index as `search_books` / `count_books`.
// Already `defineTool`-branded, so export it directly.
export default bookSearch.aggregate;
