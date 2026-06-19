import { s } from "@upstash/redis";
import type { Redis } from "@upstash/redis";

/** The raw Upstash Redis Search index handle returned by `redis.search.index(...)`. */
export type SearchIndexHandle = ReturnType<Redis["search"]["index"]>;

/** The schema type accepted by `redis.search.createIndex` / `redis.search.index`. */
type SearchSchema = Parameters<Redis["search"]["createIndex"]>[0]["schema"];

/** Scalar values usable as exact-match filters (stored as `noTokenize` tag fields). */
export type FilterValue = string | number | boolean;

interface SearchDoc {
  id: string;
  /** The free text that fuzzy `$smart` queries match against. */
  content: string;
  /** Exact-match fields ANDed with the text match at query time (must be declared as filterFields). */
  filters?: Record<string, FilterValue>;
  /** Non-searchable data stored alongside and returned with hits. */
  metadata?: Record<string, unknown>;
}

export interface SearchHit {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
  /** BM25 relevance score from Upstash Redis Search (unbounded; higher is better). */
  score: number;
}

/** The tokenized field `$smart` matches against. */
const TEXT_FIELD = "text";
/** Where non-searchable metadata is stored within each JSON document. */
const META_FIELD = "__meta";

/**
 * Internal wrapper around an Upstash Redis Search index. Each feature (memory, semantic cache, RAG)
 * owns one of these, created from the `redis` client the user passes in. It lazily creates the index,
 * writes documents as JSON (auto-synced into the index), and queries with the `$smart` fuzzy operator.
 *
 * The underlying index handle is exposed to users via each feature's `.searchIndex` getter.
 */
export class RedisSearchIndex {
  /** The raw Upstash search index handle (`query`, `count`, `waitIndexing`, `describe`, `drop`, …). */
  readonly index: SearchIndexHandle;
  private redis: Redis;
  private name: string;
  private prefix: string;
  private schema: SearchSchema;
  private created?: Promise<void>;

  constructor(redis: Redis, opts: { namespace: string; filterFields?: string[] }) {
    this.redis = redis;
    // Index names must be identifier-safe; the key prefix keeps the human-readable namespace.
    this.name = opts.namespace.replace(/[^a-zA-Z0-9_]/g, "_");
    this.prefix = `${opts.namespace}:`;
    // `text` is tokenized (fuzzy-searchable); filter fields are noTokenize tags (exact match).
    const shape: Record<string, unknown> = { [TEXT_FIELD]: s.string() };
    for (const f of opts.filterFields ?? []) shape[f] = s.string().noTokenize();
    this.schema = s.object(shape as Parameters<typeof s.object>[0]) as SearchSchema;
    this.index = redis.search.index({ name: this.name, schema: this.schema });
  }

  private keyFor(id: string): string {
    return this.prefix + id;
  }

  private idFromKey(key: string): string {
    return key.startsWith(this.prefix) ? key.slice(this.prefix.length) : key;
  }

  /** Create the index once (idempotent — "already exists" is treated as success). */
  async ensure(): Promise<void> {
    if (!this.created) {
      this.created = this.redis.search
        .createIndex({
          name: this.name,
          dataType: "json",
          prefix: this.prefix,
          schema: this.schema,
        })
        .then(() => undefined)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (!/already exists/i.test(msg)) throw err;
        });
    }
    return this.created;
  }

  /** Upsert documents (written as JSON under the index prefix). */
  async upsert(docs: SearchDoc[]): Promise<void> {
    await this.ensure();
    await Promise.all(
      docs.map((d) =>
        this.redis.json.set(this.keyFor(d.id), "$", {
          [TEXT_FIELD]: d.content,
          ...d.filters,
          ...(d.metadata ? { [META_FIELD]: d.metadata } : {}),
        }),
      ),
    );
  }

  /** Fuzzily search via `$smart`, optionally constrained by exact-match filters. */
  async search(
    query: string,
    opts: { topK?: number; filters?: Record<string, FilterValue> } = {},
  ): Promise<SearchHit[]> {
    await this.ensure();
    const filter: Record<string, unknown> = { [TEXT_FIELD]: { $smart: query }, ...opts.filters };
    const results = (await this.index.query({
      filter,
      ...(opts.topK !== undefined ? { limit: opts.topK } : {}),
    })) as { key: string; score: number; data?: Record<string, unknown> }[];
    return results.map((r) => {
      const data = r.data ?? {};
      const content = typeof data[TEXT_FIELD] === "string" ? (data[TEXT_FIELD] as string) : "";
      const metadata = data[META_FIELD] as Record<string, unknown> | undefined;
      return {
        id: this.idFromKey(r.key),
        content,
        ...(metadata !== undefined ? { metadata } : {}),
        score: r.score,
      };
    });
  }

  /** Delete documents by id. */
  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.redis.del(...ids.map((id) => this.keyFor(id)));
  }

  /** Block until pending writes are indexed (handy in tests after a burst of upserts). */
  async waitIndexing(): Promise<void> {
    await this.index.waitIndexing();
  }
}

/**
 * Detect an error/return that means "the search index doesn't exist yet". A missing Upstash index
 * doesn't fail uniformly: `query` returns `null`, `count` returns `{ count: -1 }`, and `aggregate`
 * throws a `TypeError` (the client reads `.length` of the null HTTP body). Pair this with
 * {@link withIndex}'s `isMissingResult` to cover the sentinel-return cases.
 */
export function isMissingIndexError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof TypeError && /cannot read properties of null|null \(reading/i.test(msg)) {
    return true;
  }
  return /not\s*found|does not exist|no such index|unknown index|no index/i.test(msg);
}

/**
 * Run a search-index operation; if it fails because the index doesn't exist yet — a thrown
 * {@link isMissingIndexError}, or a sentinel return flagged by `isMissingResult` (e.g. `query`→`null`,
 * `count`→`{ count: -1 }`) — provision the index via `provision` (create + `waitIndexing`) and run the
 * op once more. The op is retried at most once.
 */
export async function withIndex<T>(
  provision: () => Promise<void>,
  op: () => Promise<T>,
  isMissingResult?: (result: T) => boolean,
): Promise<T> {
  try {
    const result = await op();
    if (isMissingResult?.(result)) {
      await provision();
      return op();
    }
    return result;
  } catch (err) {
    if (!isMissingIndexError(err)) throw err;
    await provision();
    return op();
  }
}
