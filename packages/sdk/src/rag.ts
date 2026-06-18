import { randomUUID } from "node:crypto";
import type { Embedder, VectorStore } from "./types.js";
import { toQueryPayload, toVectorPayload } from "./utils.js";

export interface RagDocument {
  /** Stable document id; generated when omitted. */
  id?: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface Chunk {
  id: string;
  docId: string;
  index: number;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface RetrievedChunk extends Chunk {
  score: number;
}

export interface ChunkOptions {
  /** Target chunk size in characters. Defaults to 1000. */
  chunkSize?: number;
  /** Overlap between consecutive chunks in characters. Defaults to 200. */
  chunkOverlap?: number;
}

export interface RagConfig extends ChunkOptions {
  vector: VectorStore;
  embedder?: Embedder;
  /** Vector namespace; defaults to `agentkit:rag`. */
  namespace?: string;
}

/**
 * Splits `text` into overlapping chunks on whitespace boundaries. Overlap preserves context across
 * chunk edges so a retrieved chunk rarely cuts a sentence in half mid-thought.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const chunkSize = opts.chunkSize ?? 1000;
  const overlap = opts.chunkOverlap ?? 200;
  if (overlap >= chunkSize) {
    throw new Error(`chunkOverlap (${overlap}) must be smaller than chunkSize (${chunkSize}).`);
  }
  const clean = text.trim();
  if (clean.length <= chunkSize) return clean.length ? [clean] : [];

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + chunkSize, clean.length);
    // Prefer to break on a whitespace boundary when not at the very end.
    if (end < clean.length) {
      const lastSpace = clean.lastIndexOf(" ", end);
      if (lastSpace > start) end = lastSpace;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = end - overlap;
    if (start < 0) start = 0;
  }
  return chunks;
}

/**
 * Minimal Retrieval-Augmented Generation toolkit: chunk documents, embed and index the chunks in a
 * vector store, then retrieve the most relevant chunks for a query. Bring your own {@link Embedder}
 * or rely on the vector store's built-in embedding.
 */
export class Rag {
  private vector: VectorStore;
  private embedder?: Embedder;
  private namespace: string;
  private chunkSize: number;
  private chunkOverlap: number;

  constructor(config: RagConfig) {
    this.vector = config.vector;
    this.embedder = config.embedder;
    this.namespace = config.namespace ?? "agentkit:rag";
    this.chunkSize = config.chunkSize ?? 1000;
    this.chunkOverlap = config.chunkOverlap ?? 200;
  }

  /** Chunk, embed, and index documents. Returns the chunks that were created. */
  async ingest(documents: RagDocument | RagDocument[], opts: ChunkOptions = {}): Promise<Chunk[]> {
    const docs = Array.isArray(documents) ? documents : [documents];
    const chunkSize = opts.chunkSize ?? this.chunkSize;
    const chunkOverlap = opts.chunkOverlap ?? this.chunkOverlap;
    const created: Chunk[] = [];

    for (const doc of docs) {
      const docId = doc.id ?? randomUUID();
      const pieces = chunkText(doc.text, { chunkSize, chunkOverlap });
      const records = await Promise.all(
        pieces.map(async (text, index) => {
          const id = `${docId}:${index}`;
          const chunk: Chunk = { id, docId, index, text, metadata: doc.metadata };
          created.push(chunk);
          const payload = await toVectorPayload(text, this.embedder);
          return {
            id,
            ...payload,
            metadata: { docId, index, text, ...doc.metadata },
          };
        }),
      );
      if (records.length) await this.vector.upsert(records, { namespace: this.namespace });
    }
    return created;
  }

  /** Retrieve the chunks most relevant to `query`. */
  async retrieve(
    query: string,
    opts: { topK?: number; minScore?: number; filter?: string } = {},
  ): Promise<RetrievedChunk[]> {
    const payload = await toQueryPayload(query, this.embedder);
    const matches = await this.vector.query({
      ...payload,
      topK: opts.topK ?? 5,
      namespace: this.namespace,
      filter: opts.filter,
      includeMetadata: true,
    });
    const minScore = opts.minScore ?? 0;
    return matches
      .filter((m) => m.score >= minScore)
      .map((m) => {
        const md = (m.metadata ?? {}) as {
          docId?: string;
          index?: number;
          text?: string;
          [k: string]: unknown;
        };
        const { docId, index, text, ...rest } = md;
        return {
          id: m.id,
          docId: docId ?? "",
          index: index ?? 0,
          text: text ?? "",
          metadata: Object.keys(rest).length ? rest : undefined,
          score: m.score,
        };
      });
  }

  /** Remove all chunks belonging to a document (chunk ids are `${docId}:${n}`). */
  async remove(docId: string, opts: { chunkCount: number }): Promise<void> {
    const ids = Array.from({ length: opts.chunkCount }, (_, i) => `${docId}:${i}`);
    await this.vector.delete(ids, { namespace: this.namespace });
  }
}
