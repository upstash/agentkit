import type { SearchHit, SearchQuery, SearchStore, SearchDocument } from "./types.js";

/** A document as returned by an Upstash search query. */
export interface UpstashSearchResult {
  id: string | number;
  content?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  score: number;
}

/**
 * The slice of an Upstash Redis Search index surface we depend on (`redis.search.index(...)`).
 * Declared structurally so the SDK never imports `@upstash/redis`.
 */
export interface UpstashSearchIndexLike {
  upsert(
    documents: {
      id: string;
      content: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    }[],
  ): Promise<unknown>;
  query(args: {
    filter: Record<string, unknown>;
    topK?: number;
  }): Promise<UpstashSearchResult[] | { documents: UpstashSearchResult[] }>;
  delete(ids: string[]): Promise<unknown>;
}

export interface UpstashSearchStoreOptions {
  /**
   * The tokenized content field that `$smart` queries match against. Documents are stored as
   * `{ content: { [textField]: text, ...filters } }`. Defaults to `"text"`.
   */
  textField?: string;
}

/**
 * Wrap an Upstash Redis Search index as a {@link SearchStore}, using the `$smart` fuzzy operator for
 * queries. Exact-match `filters` (e.g. a scope/user id) are stored on the content object and ANDed
 * with the text match at query time.
 *
 * ```ts
 * import { Redis, s } from "@upstash/redis";
 * const redis = Redis.fromEnv();
 * await redis.search.createIndex({
 *   name: "agentkit",
 *   dataType: "json",
 *   prefix: "agentkit:",
 *   schema: s.object({ text: s.string(), scope: s.string().noTokenize(), docId: s.string().noTokenize() }),
 * });
 * const store = upstashSearchStore(redis.search.index({ name: "agentkit", schema }));
 * ```
 */
export function upstashSearchStore(
  index: UpstashSearchIndexLike,
  options: UpstashSearchStoreOptions = {},
): SearchStore {
  const textField = options.textField ?? "text";

  return {
    async upsert(documents: SearchDocument[]) {
      await index.upsert(
        documents.map((d) => ({
          id: d.id,
          content: { [textField]: d.content, ...d.filters },
          ...(d.metadata !== undefined ? { metadata: d.metadata } : {}),
        })),
      );
    },
    async search(query: SearchQuery): Promise<SearchHit[]> {
      const filter: Record<string, unknown> = {
        [textField]: { $smart: query.query },
        ...query.filters,
      };
      const res = await index.query({
        filter,
        ...(query.topK !== undefined ? { topK: query.topK } : {}),
      });
      const docs = Array.isArray(res) ? res : res.documents;
      return docs.map((d) => ({
        id: String(d.id),
        content: typeof d.content?.[textField] === "string" ? (d.content[textField] as string) : "",
        ...(d.metadata !== undefined ? { metadata: d.metadata } : {}),
        score: d.score,
      }));
    },
    async delete(ids: string[]) {
      await index.delete(ids);
    },
  };
}
