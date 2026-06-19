import {
  Rag,
  type RagConfig,
  type RetrievedChunk,
  type SearchIndexHandle,
} from "@upstash/agentkit-sdk";
import type { DocumentLike, RetrieverLike } from "./types.js";

export interface AgentKitRetrieverConfig extends RagConfig {
  /** How many chunks to retrieve per query. Defaults to 4 (LangChain's default `k`). */
  topK?: number;
  /** Drop matches below this relevance score. */
  minScore?: number;
  /** Restrict retrieval to chunks from a single source document (exact-match on its id). */
  docId?: string;
}

/** Document shape LangChain ingestion APIs hand to a retriever. */
export interface IngestDocument {
  pageContent: string;
  metadata?: Record<string, unknown>;
}

/**
 * A LangChain-style retriever backed by the AgentKit {@link Rag} toolkit (Upstash Redis Search).
 *
 * It mirrors `BaseRetriever`'s surface — both the legacy `getRelevantDocuments(query)` and the
 * runnable `invoke(query)` — returning LangChain {@link DocumentLike} objects mapped from
 * {@link RetrievedChunk}s. `addDocuments` lets you ingest LangChain `Document`s straight through
 * `Rag.ingest`, so the same instance can index and retrieve.
 *
 * @example
 * ```ts
 * const retriever = new AgentKitRetriever({ redis, topK: 3 });
 * await retriever.addDocuments([{ pageContent: "Upstash is serverless." }]);
 * const docs = await retriever.invoke("what is upstash?");
 * // docs: [{ pageContent, metadata }, ...]
 * ```
 */
export class AgentKitRetriever implements RetrieverLike {
  private rag: Rag;
  private topK: number;
  private minScore?: number;
  private docId?: string;

  constructor(config: AgentKitRetrieverConfig) {
    const { topK, minScore, docId, ...ragConfig } = config;
    this.rag = new Rag(ragConfig);
    this.topK = topK ?? 4;
    this.minScore = minScore;
    this.docId = docId;
  }

  /** The underlying Upstash Redis Search index handle (e.g. to `waitIndexing` in tests). */
  get searchIndex(): SearchIndexHandle {
    return this.rag.searchIndex;
  }

  /** Retrieve the documents most relevant to `query`, as LangChain-style documents. */
  async getRelevantDocuments(query: string): Promise<DocumentLike[]> {
    const chunks = await this.rag.retrieve(query, {
      topK: this.topK,
      minScore: this.minScore,
      docId: this.docId,
    });
    return chunks.map(toDocument);
  }

  /** Runnable-style alias for {@link getRelevantDocuments}, matching LangChain `Runnable.invoke`. */
  async invoke(query: string): Promise<DocumentLike[]> {
    return this.getRelevantDocuments(query);
  }

  /**
   * Ingest LangChain `Document`s into the underlying search index via `Rag.ingest`. The `pageContent`
   * becomes the document text and `metadata` is carried through onto every chunk.
   */
  async addDocuments(documents: IngestDocument[]): Promise<void> {
    if (documents.length === 0) return;
    await this.rag.ingest(
      documents.map((doc) => ({ text: doc.pageContent, metadata: doc.metadata })),
    );
  }
}

/** Map an AgentKit {@link RetrievedChunk} onto a LangChain {@link DocumentLike}. */
function toDocument(chunk: RetrievedChunk): DocumentLike {
  return {
    pageContent: chunk.text,
    metadata: {
      ...chunk.metadata,
      docId: chunk.docId,
      index: chunk.index,
      score: chunk.score,
    },
  };
}
