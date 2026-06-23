import { randomUUID } from "node:crypto";
import type { Redis } from "@upstash/redis";
import { RedisSearchIndex, type SearchIndexHandle } from "./search-index.js";

/** A document to ingest: its typed `data` plus an optional stable `id`. */
export interface RagDocument<TData = Record<string, unknown>> {
  /** Stable document id; generated when omitted. */
  id?: string;
  /** The document itself (typed via the generic). Fuzzily searchable and returned as-is on retrieval. */
  data: TData;
}

/** A stored document — like {@link RagDocument} but with its `id` resolved. */
export interface StoredDocument<TData = Record<string, unknown>> {
  id: string;
  data: TData;
}

export interface RetrievedDocument<TData = Record<string, unknown>> extends StoredDocument<TData> {
  /** BM25 relevance score from Upstash Redis Search (unbounded; higher is better). */
  score: number;
}

export interface RagConfig {
  /** The Upstash Redis client. The search index is created and managed internally. */
  redis: Redis;
  /** Key prefix + index name base; defaults to `agentkit:rag`. */
  namespace?: string;
}

/** Flatten a document's `data` into the text `$smart` matches against (string/number values, recursive). */
function toSearchText(data: unknown): string {
  if (typeof data === "string") return data;
  if (typeof data === "number" || typeof data === "boolean") return String(data);
  if (Array.isArray(data)) return data.map(toSearchText).filter(Boolean).join(" ");
  if (data && typeof data === "object") {
    return Object.values(data as Record<string, unknown>)
      .map(toSearchText)
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

/**
 * Minimal Retrieval-Augmented Generation toolkit over Upstash Redis Search: ingest documents, then
 * fuzzily retrieve the most relevant ones for a query via the `$smart` operator. A document is just
 * your typed `data` (no separate text field) — its string/number values are indexed for matching, and
 * the `data` is returned as-is on retrieval.
 *
 * Pass only the `redis` client; the toolkit owns its index internally (exposed via {@link searchIndex}).
 */
export class Rag<TData = Record<string, unknown>> {
  private store: RedisSearchIndex;

  constructor(config: RagConfig) {
    this.store = new RedisSearchIndex(config.redis, {
      namespace: config.namespace ?? "agentkit:rag",
    });
  }

  /** The underlying Upstash Redis Search index handle. */
  get searchIndex(): SearchIndexHandle {
    return this.store.index;
  }

  /**
   * Ingest a single document or an array of documents. Each gets a generated `id` when omitted, and is
   * stored at `${namespace}:${id}`. Returns the stored documents with their resolved ids.
   */
  async ingest(
    documents: RagDocument<TData> | RagDocument<TData>[],
  ): Promise<StoredDocument<TData>[]> {
    const docs = Array.isArray(documents) ? documents : [documents];
    const stored: StoredDocument<TData>[] = [];
    const records: Parameters<RedisSearchIndex["upsert"]>[0] = [];

    for (const doc of docs) {
      const id = doc.id ?? randomUUID();
      stored.push({ id, data: doc.data });
      records.push({ id, content: toSearchText(doc.data), metadata: { data: doc.data } });
    }
    if (records.length) await this.store.upsert(records);
    return stored;
  }

  /** Fuzzily retrieve the documents most relevant to `query`. */
  async retrieve(
    query: string,
    opts: { topK?: number; minScore?: number } = {},
  ): Promise<RetrievedDocument<TData>[]> {
    const hits = await this.store.search(query, { topK: opts.topK ?? 5 });
    const minScore = opts.minScore ?? 0;
    return hits
      .filter((h) => h.score >= minScore)
      .map((h) => ({
        id: h.id,
        data: (h.metadata as { data: TData } | undefined)?.data as TData,
        score: h.score,
      }));
  }

  /** Remove a document by id. */
  async remove(id: string): Promise<void> {
    await this.store.delete([id]);
  }
}
