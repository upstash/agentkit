import { Rag, type RagConfig, type RetrievedChunk } from "@upstash/agentkit-sdk";
import type { DocumentLike, RetrieverLike } from "./types.js";

export interface AgentKitRetrieverConfig extends RagConfig {
  /** How many chunks to retrieve per query. Defaults to 4 (LangChain's default `k`). */
  topK?: number;
  /** Drop matches below this similarity score. */
  minScore?: number;
  /** Provider-specific metadata filter expression passed through to the vector store. */
  filter?: string;
}

/** Document shape LangChain ingestion APIs hand to a vector store / retriever. */
export interface IngestDocument {
  pageContent: string;
  metadata?: Record<string, unknown>;
}

/**
 * A LangChain-style retriever backed by the AgentKit {@link Rag} toolkit (Upstash Vector).
 *
 * It mirrors `BaseRetriever`'s surface — both the legacy `getRelevantDocuments(query)` and the
 * runnable `invoke(query)` — returning LangChain {@link DocumentLike} objects mapped from
 * {@link RetrievedChunk}s. `addDocuments` lets you ingest LangChain `Document`s straight through
 * `Rag.ingest`, so the same instance can index and retrieve.
 *
 * @example
 * ```ts
 * const retriever = new AgentKitRetriever({ vector, embedder, topK: 3 });
 * await retriever.addDocuments([{ pageContent: "Upstash is serverless." }]);
 * const docs = await retriever.invoke("what is upstash?");
 * // docs: [{ pageContent, metadata }, ...]
 * ```
 */
export class AgentKitRetriever implements RetrieverLike {
  private rag: Rag;
  private topK: number;
  private minScore?: number;
  private filter?: string;

  constructor(config: AgentKitRetrieverConfig) {
    const { topK, minScore, filter, ...ragConfig } = config;
    this.rag = new Rag(ragConfig);
    this.topK = topK ?? 4;
    this.minScore = minScore;
    this.filter = filter;
  }

  /** Retrieve the documents most relevant to `query`, as LangChain-style documents. */
  async getRelevantDocuments(query: string): Promise<DocumentLike[]> {
    const chunks = await this.rag.retrieve(query, {
      topK: this.topK,
      minScore: this.minScore,
      filter: this.filter,
    });
    return chunks.map(toDocument);
  }

  /** Runnable-style alias for {@link getRelevantDocuments}, matching LangChain `Runnable.invoke`. */
  async invoke(query: string): Promise<DocumentLike[]> {
    return this.getRelevantDocuments(query);
  }

  /**
   * Ingest LangChain `Document`s into the underlying vector index via `Rag.ingest`. The `pageContent`
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
