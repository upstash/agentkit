import { bookSearch } from "../lib/book-search.js";

// Count of books matching a filter over the books index. Same index as
// `search_books` / `aggregate_books`. Already `defineTool`-branded, export directly.
export default bookSearch.count;
