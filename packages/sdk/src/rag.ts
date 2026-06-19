import { randomUUID } from "node:crypto";
import type { FilterValue, SearchStore } from "./types.js";

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
  search: SearchStore;
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
 * Minimal Retrieval-Augmented Generation toolkit over Upstash Redis Search: chunk documents, index
 * the chunks as searchable documents, then fuzzily retrieve the most relevant chunks for a query via
 * the `$smart` operator.
 */
export class Rag {
  private search: SearchStore;
  private chunkSize: number;
  private chunkOverlap: number;

  constructor(config: RagConfig) {
    this.search = config.search;
    this.chunkSize = config.chunkSize ?? 1000;
    this.chunkOverlap = config.chunkOverlap ?? 200;
  }

  /** Chunk and index documents. Returns the chunks that were created. */
  async ingest(documents: RagDocument | RagDocument[], opts: ChunkOptions = {}): Promise<Chunk[]> {
    const docs = Array.isArray(documents) ? documents : [documents];
    const chunkSize = opts.chunkSize ?? this.chunkSize;
    const chunkOverlap = opts.chunkOverlap ?? this.chunkOverlap;
    const created: Chunk[] = [];

    for (const doc of docs) {
      const docId = doc.id ?? randomUUID();
      const pieces = chunkText(doc.text, { chunkSize, chunkOverlap });
      const records = pieces.map((text, index) => {
        const id = `${docId}:${index}`;
        created.push({ id, docId, index, text, metadata: doc.metadata });
        return {
          id,
          content: text,
          metadata: { docId, index, text, ...doc.metadata },
          filters: { docId } as Record<string, FilterValue>,
        };
      });
      if (records.length) await this.search.upsert(records);
    }
    return created;
  }

  /** Fuzzily retrieve the chunks most relevant to `query`. */
  async retrieve(
    query: string,
    opts: { topK?: number; minScore?: number; docId?: string } = {},
  ): Promise<RetrievedChunk[]> {
    const hits = await this.search.search({
      query,
      topK: opts.topK ?? 5,
      ...(opts.docId !== undefined ? { filters: { docId: opts.docId } } : {}),
    });
    const minScore = opts.minScore ?? 0;
    return hits
      .filter((h) => h.score >= minScore)
      .map((h) => {
        const md = (h.metadata ?? {}) as {
          docId?: string;
          index?: number;
          text?: string;
          [k: string]: unknown;
        };
        const { docId, index, text, ...rest } = md;
        return {
          id: h.id,
          docId: docId ?? "",
          index: index ?? 0,
          text: text ?? h.content,
          metadata: Object.keys(rest).length ? rest : undefined,
          score: h.score,
        };
      });
  }

  /** Remove all chunks belonging to a document (chunk ids are `${docId}:${n}`). */
  async remove(docId: string, opts: { chunkCount: number }): Promise<void> {
    const ids = Array.from({ length: opts.chunkCount }, (_, i) => `${docId}:${i}`);
    await this.search.delete(ids);
  }
}
