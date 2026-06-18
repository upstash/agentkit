import type { VectorMatch, VectorQuery, VectorRecord, VectorStore } from "./types.js";

/**
 * The slice of the `@upstash/vector` `Index` surface we depend on. Declared structurally so the SDK
 * doesn't take a hard dependency on the package.
 */
export interface UpstashVectorIndex {
  upsert(
    records: { id: string; vector?: number[]; data?: string; metadata?: Record<string, unknown> }[],
    opts?: { namespace?: string },
  ): Promise<string>;
  query(
    query: {
      vector?: number[];
      data?: string;
      topK: number;
      filter?: string;
      includeMetadata?: boolean;
      includeData?: boolean;
    },
    opts?: { namespace?: string },
  ): Promise<
    { id: string | number; score: number; metadata?: Record<string, unknown>; data?: string }[]
  >;
  delete(ids: string[], opts?: { namespace?: string }): Promise<{ deleted: number }>;
}

/**
 * Wrap an `@upstash/vector` `Index` as a {@link VectorStore}.
 *
 * ```ts
 * import { Index } from "@upstash/vector";
 * const store = upstashVectorStore(new Index());
 * ```
 */
export function upstashVectorStore(index: UpstashVectorIndex): VectorStore {
  return {
    async upsert(records: VectorRecord[], opts) {
      await index.upsert(
        records.map((r) => ({
          id: r.id,
          vector: r.vector,
          data: r.data,
          metadata: r.metadata,
        })),
        opts?.namespace ? { namespace: opts.namespace } : undefined,
      );
    },
    async query(query: VectorQuery): Promise<VectorMatch[]> {
      const results = await index.query(
        {
          vector: query.vector,
          data: query.data,
          topK: query.topK,
          filter: query.filter,
          includeMetadata: query.includeMetadata,
          includeData: query.includeData,
        },
        query.namespace ? { namespace: query.namespace } : undefined,
      );
      return results.map((r) => ({
        id: String(r.id),
        score: r.score,
        metadata: r.metadata,
        data: r.data,
      }));
    },
    async delete(ids: string[], opts) {
      await index.delete(ids, opts?.namespace ? { namespace: opts.namespace } : undefined);
    },
  };
}
