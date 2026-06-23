import type { FlatIndexSchema, NestedIndexSchema, Redis, SearchIndex } from "@upstash/redis";

/** The schema type accepted by `redis.search.index` / `createIndex` (an `s.object({...})`). */
export type AnySearchSchema = NestedIndexSchema | FlatIndexSchema;

/**
 * Detect an error that means "the search index doesn't exist yet". A missing Upstash index doesn't
 * fail uniformly: `query` returns `null`, `count` returns `{ count: -1 }`, and `aggregate` throws a
 * `TypeError` (the client reads `.length` of the null HTTP body).
 */
function isMissingIndexError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof TypeError && /cannot read properties of null|null \(reading/i.test(msg)) {
    return true;
  }
  return /not\s*found|does not exist|no such index|unknown index|no index/i.test(msg);
}

export interface ReactiveSearchIndexConfig<TSchema extends AnySearchSchema> {
  /** The Upstash Redis client. */
  redis: Redis;
  /** The Redis Search index name. */
  indexName: string;
  /** The JSON-document key prefix the index covers (e.g. `"agentkit:memory:"`). */
  prefix: string;
  /** The Upstash Redis Search schema (an `s.object({...})`). */
  schema: TSchema;
}

/**
 * A {@link SearchIndex} wrapper that **provisions the index reactively on the read path**. Writes go
 * straight to `redis.json.set` and never need the index to exist — so features don't call any
 * `ensure()` when saving. The first `query`/`aggregate`/`count` that hits a missing index creates it
 * (+ `waitIndexing`) and retries the op once; subsequent reads skip straight through.
 *
 * It mirrors the `SearchIndex` read surface (`query`/`aggregate`/`count`) plus `waitIndexing`/`drop`/
 * `describe`, and exposes the raw handle as `.index` for anything else.
 */
export class ReactiveSearchIndex<TSchema extends AnySearchSchema> {
  /** The underlying Upstash `SearchIndex` (for advanced, non-reactive use). */
  readonly index: SearchIndex<TSchema>;
  private redis: Redis;
  private indexName: string;
  private prefix: string;
  private schema: TSchema;
  private created?: Promise<void>;

  constructor(config: ReactiveSearchIndexConfig<TSchema>) {
    this.redis = config.redis;
    this.indexName = config.indexName;
    this.prefix = config.prefix;
    this.schema = config.schema;
    this.index = config.redis.search.index({ name: this.indexName, schema: this.schema });
  }

  /** Create the index (idempotent via `existsOk`). */
  private createIndex(): Promise<void> {
    return this.redis.search
      .createIndex({
        name: this.indexName,
        dataType: "json",
        prefix: this.prefix,
        schema: this.schema,
        existsOk: true, // no-op if the index already exists
        // `createIndex`'s generic can't infer through ours; cast to its real parameter type.
      } as Parameters<Redis["search"]["createIndex"]>[0])
      .then(() => undefined);
  }

  private ensure(): Promise<void> {
    if (!this.created) this.created = this.createIndex();
    return this.created;
  }

  /** Create the index and wait until it's queryable — the recovery path on a missing index. */
  private async provision(): Promise<void> {
    this.created = undefined;
    await this.ensure();
    await this.index.waitIndexing();
  }

  /** Run a read op; on a missing index (sentinel return or thrown error) provision and retry once. */
  private async reactive<T>(
    op: () => Promise<T>,
    isMissingResult?: (result: T) => boolean,
  ): Promise<T> {
    try {
      const result = await op();
      if (isMissingResult?.(result)) {
        await this.provision();
        return op();
      }
      return result;
    } catch (err) {
      if (!isMissingIndexError(err)) throw err;
      await this.provision();
      return op();
    }
  }

  /** Query the index, creating it first if it doesn't exist yet. */
  query(
    ...args: Parameters<SearchIndex<TSchema>["query"]>
  ): ReturnType<SearchIndex<TSchema>["query"]> {
    return this.reactive(
      () => this.index.query(...args) as Promise<unknown>,
      (r) => r === null, // missing index → query returns null
    ) as ReturnType<SearchIndex<TSchema>["query"]>;
  }

  /** Aggregate over the index, creating it first if it doesn't exist yet. */
  aggregate(
    ...args: Parameters<SearchIndex<TSchema>["aggregate"]>
  ): ReturnType<SearchIndex<TSchema>["aggregate"]> {
    // missing index → aggregate throws (caught by `reactive`), so no sentinel needed.
    return this.reactive(() => this.index.aggregate(...args) as Promise<unknown>) as ReturnType<
      SearchIndex<TSchema>["aggregate"]
    >;
  }

  /** Count documents, creating the index first if it doesn't exist yet. */
  count(
    ...args: Parameters<SearchIndex<TSchema>["count"]>
  ): ReturnType<SearchIndex<TSchema>["count"]> {
    return this.reactive(
      () => this.index.count(...args) as Promise<{ count: number }>,
      (r) => r.count === -1, // missing index → { count: -1 }
    ) as ReturnType<SearchIndex<TSchema>["count"]>;
  }

  /** Block until pending writes are indexed. */
  waitIndexing(): ReturnType<SearchIndex<TSchema>["waitIndexing"]> {
    return this.index.waitIndexing();
  }

  /** Drop the index. */
  drop(): ReturnType<SearchIndex<TSchema>["drop"]> {
    return this.index.drop();
  }

  /** Describe the index (or `null` if it doesn't exist). */
  describe(): ReturnType<SearchIndex<TSchema>["describe"]> {
    return this.index.describe();
  }
}
