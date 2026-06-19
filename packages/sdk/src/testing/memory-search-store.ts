import type { SearchDocument, SearchHit, SearchQuery, SearchStore } from "../types.js";

interface StoredDoc {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
  filters?: Record<string, string | number | boolean>;
  tokens: string[];
}

/**
 * A dependency-free in-memory {@link SearchStore} for tests and local demos. It approximates Upstash
 * Redis Search's `$smart` operator: a blend of exact term, fuzzy (Levenshtein), and prefix matching
 * with a phrase boost, producing a relevance score normalized to `[0, 1]`. Exact-match `filters` are
 * ANDed with the text match. Not for production use.
 */
export class MemorySearchStore implements SearchStore {
  private docs = new Map<string, StoredDoc>();

  /** Remove all documents. */
  clear(): void {
    this.docs.clear();
  }

  async upsert(documents: SearchDocument[]): Promise<void> {
    for (const d of documents) {
      this.docs.set(d.id, {
        id: d.id,
        content: d.content,
        metadata: d.metadata,
        filters: d.filters,
        tokens: tokenize(d.content),
      });
    }
  }

  async search(query: SearchQuery): Promise<SearchHit[]> {
    const qTokens = unique(tokenize(query.query));
    const qLower = query.query.toLowerCase();

    const scored: SearchHit[] = [];
    for (const doc of this.docs.values()) {
      if (!matchesFilters(doc, query.filters)) continue;
      const score = scoreDoc(qTokens, qLower, doc);
      if (score <= 0) continue;
      scored.push({
        id: doc.id,
        content: doc.content,
        ...(doc.metadata !== undefined ? { metadata: doc.metadata } : {}),
        score,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, query.topK ?? 10);
  }

  async delete(ids: string[]): Promise<void> {
    for (const id of ids) this.docs.delete(id);
  }
}

function matchesFilters(doc: StoredDoc, filters?: SearchQuery["filters"]): boolean {
  if (!filters) return true;
  for (const [k, v] of Object.entries(filters)) {
    if (!doc.filters || doc.filters[k] !== v) return false;
  }
  return true;
}

function scoreDoc(qTokens: string[], qLower: string, doc: StoredDoc): number {
  if (qTokens.length === 0) return 0;
  const dTokens = unique(doc.tokens);
  if (dTokens.length === 0) return 0;

  let matched = 0;
  for (const q of qTokens) matched += bestWeight(q, dTokens);

  // Overlap-coefficient style basis: divide by the smaller token set so a short cached prompt can
  // still strongly match a more verbose paraphrase (and vice-versa).
  const basis = Math.max(1, Math.min(qTokens.length, dTokens.length));
  let score = Math.min(1, matched / basis);

  // Phrase boost: the full query appears verbatim in the content.
  if (doc.content.toLowerCase().includes(qLower)) {
    score = Math.max(score, 0.95);
  }
  return score;
}

/** Best per-token match weight against the document tokens: exact > fuzzy > prefix. */
function bestWeight(token: string, dTokens: string[]): number {
  let best = 0;
  for (const d of dTokens) {
    if (d === token) return 1;
    const maxDist = token.length <= 4 ? 1 : 2;
    if (Math.abs(d.length - token.length) <= maxDist && levenshtein(token, d) <= maxDist) {
      best = Math.max(best, 0.8);
      continue;
    }
    if (token.length >= 3 && (d.startsWith(token) || token.startsWith(d))) {
      best = Math.max(best, 0.5);
    }
  }
  return best;
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "of",
  "to",
  "in",
  "on",
  "for",
  "and",
  "or",
  "what",
  "who",
  "whom",
  "does",
  "do",
  "did",
  "how",
  "me",
  "my",
  "i",
  "you",
  "your",
  "it",
  "its",
  "that",
  "this",
  "with",
  "about",
  "please",
  "tell",
  "give",
  "us",
  "we",
  "they",
  "their",
  "at",
  "by",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function unique(arr: string[]): string[] {
  return [...new Set(arr)];
}

/** Standard Levenshtein edit distance. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((curr[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] ?? 0;
}
