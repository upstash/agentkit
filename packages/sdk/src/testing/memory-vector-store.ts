import type { VectorMatch, VectorQuery, VectorRecord, VectorStore } from "../types.js";
import { cosineSimilarity } from "../utils.js";

interface StoredVector {
  id: string;
  vector: number[];
  metadata?: Record<string, unknown>;
  data?: string;
}

/**
 * In-memory {@link VectorStore} for tests. Uses cosine similarity over injected vectors. When records
 * are upserted with `data` instead of `vector`, a deterministic fallback embedder is required via the
 * constructor so the store can embed both records and queries consistently.
 */
export class MemoryVectorStore implements VectorStore {
  private namespaces = new Map<string, Map<string, StoredVector>>();
  private embed?: (text: string) => number[];

  constructor(opts: { embed?: (text: string) => number[] } = {}) {
    this.embed = opts.embed;
  }

  private ns(namespace?: string): Map<string, StoredVector> {
    const name = namespace ?? "";
    let m = this.namespaces.get(name);
    if (!m) {
      m = new Map();
      this.namespaces.set(name, m);
    }
    return m;
  }

  private resolveVector(rec: { vector?: number[]; data?: string }): number[] {
    if (rec.vector) return rec.vector;
    if (rec.data !== undefined) {
      if (!this.embed) {
        throw new Error(
          "MemoryVectorStore received `data` but no `embed` function was provided to the constructor.",
        );
      }
      return this.embed(rec.data);
    }
    throw new Error("Vector record must include `vector` or `data`.");
  }

  async upsert(records: VectorRecord[], opts: { namespace?: string } = {}): Promise<void> {
    const m = this.ns(opts.namespace);
    for (const rec of records) {
      m.set(rec.id, {
        id: rec.id,
        vector: this.resolveVector(rec),
        metadata: rec.metadata,
        data: rec.data,
      });
    }
  }

  async query(query: VectorQuery): Promise<VectorMatch[]> {
    const m = this.ns(query.namespace);
    const qVector = this.resolveVector(query);
    const scored = [...m.values()].map((v) => ({
      id: v.id,
      score: cosineSimilarity(qVector, v.vector),
      metadata: query.includeMetadata ? v.metadata : undefined,
      data: query.includeData ? v.data : undefined,
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, query.topK);
  }

  async delete(ids: string[], opts: { namespace?: string } = {}): Promise<void> {
    const m = this.ns(opts.namespace);
    for (const id of ids) m.delete(id);
  }
}
