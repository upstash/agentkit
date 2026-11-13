import { randomUUID } from "node:crypto";
import { s } from "@upstash/redis";
import type { FlatIndexSchema, InferFilterFromSchema, Redis } from "@upstash/redis";
import { ReactiveSearchIndex } from "./reactive-index.js";
import {
  SHARED_INDEX_NAME,
  SHARED_MEMORY_PREFIX,
  SHARED_PREFIXES,
  SharedSchema,
} from "./shared-index.js";
import { addTelemetry } from "./telemetry.js";
import { now } from "./utils.js";

/**
 * Reject an empty/missing userId, or one containing the `:` key separator. The userId is the only
 * tenant boundary for memory, so a blank one would silently collapse every caller into one shared
 * bucket — and a `:` would let `<userId>:<id>` collide across users (e.g. userId `"a"` + id `"b:c"`
 * lands on the same key as userId `"a:b"` + id `"c"`), breaking the per-user isolation by direct key.
 */
function assertUserId(userId: string | undefined): asserts userId is string {
  if (userId === undefined || userId === "") {
    throw new Error("AgentMemory: `userId` is required and must be a non-empty string.");
  }
  if (userId.includes(":")) {
    throw new Error("AgentMemory: `userId` must not contain ':' (it is the key separator).");
  }
}

/** A store that declares no `metadataSchema`: it carries no metadata and has nothing to filter on. */
type EmptySchema = Record<never, never>;

/**
 * The built field object a schema builder produces — `{type: "TEXT", …}` for `s.string()`,
 * `{type: "BOOL"}` for `s.boolean()`, and so on.
 *
 * `@upstash/redis` does not export the builder classes, so the built shape is recovered
 * structurally rather than by naming them: every builder carries exactly one zero-argument method
 * (keyed by an internal symbol) that returns the field object, and none of its other public methods
 * returns anything with a `type` property — `noTokenize()`/`fast()` return builders, and `from()`
 * takes an argument. Deriving it this way means the field-type mapping below is the only thing
 * restated from the library.
 */
type BuiltField<TBuilder> =
  Extract<TBuilder[keyof TBuilder], () => { type: string }> extends () => infer TField
    ? TField
    : never;

/** The JS value an indexed field carries, mirroring Upstash's own field-type table. */
type FieldValue<TField> = TField extends { type: infer TType }
  ? TType extends "TEXT" | "KEYWORD" | "DATE" | "FACET"
    ? string
    : TType extends "U64" | "I64" | "F64"
      ? number
      : TType extends "BOOL"
        ? boolean
        : never
  : never;

/**
 * Constraint for `metadataSchema`: every value must be a builder `s` produces. Self-referential the
 * same way `s.object`'s own parameter is, so a bad entry is reported on the offending key instead of
 * collapsing the whole object.
 */
export type MetadataSchemaShape<TSchema> = {
  [K in keyof TSchema]: [FieldValue<BuiltField<TSchema[K]>>] extends [never] ? never : TSchema[K];
};

/**
 * The `metadata` object a store carries, derived from the fields its `metadataSchema` declares:
 * `s.string()` → `string`, `s.number()` → `number`, `s.boolean()` → `boolean`.
 */
export type MetadataOf<TSchema> = {
  [K in keyof TSchema]: FieldValue<BuiltField<TSchema[K]>>;
};

/** The built schema, as Upstash's own filter/query types want to see it. */
type BuiltSchema<TSchema> = {
  [K in keyof TSchema]: BuiltField<TSchema[K]>;
};

/**
 * Filter clauses over the declared metadata fields — the field names come from `metadataSchema`, and
 * each operand is checked against that field's type (`{deleted: {$eq: false}}` is accepted,
 * `{deleted: {$eq: "false"}}` and `{notAField: …}` are not).
 */
export type MetadataFilter<TSchema> =
  BuiltSchema<TSchema> extends infer TBuilt
    ? TBuilt extends FlatIndexSchema
      ? InferFilterFromSchema<TBuilt>
      : never
    : never;

export interface MemoryRecord<TMetadata = Record<string, unknown>> {
  id: string;
  text: string;
  createdAt: number;
  /**
   * Extra fields this store was configured to carry, via
   * {@link AgentMemoryConfig.metadataSchema}. They are stored as **top-level, indexed** fields, so
   * unlike `createdAt` they can be filtered on — that is the whole point of declaring them.
   */
  metadata?: TMetadata;
}

export interface RecalledMemory<
  TMetadata = Record<string, unknown>,
> extends MemoryRecord<TMetadata> {
  /** BM25 for a keyword match; a rank-fusion value (comparable within one query only) for hybrid. */
  score: number;
}

export interface AgentMemoryConfig<TSchema = EmptySchema> {
  /** The Upstash Redis client. The search index is created and managed internally. */
  redis: Redis;
  /**
   * Base key prefix for stored memories. Defaults to `agentkit:memory`, in the `agentkit` index it
   * shares with `ChatHistory` (one index, so both work on a database that allows only one). Set it
   * (or `indexName` or `metadataSchema`) to give the store its own index over `<prefix>:`.
   */
  prefix?: string;
  /** Redis Search index name for a store with its own index. Defaults to the (identifier-safe) `prefix`. */
  indexName?: string;
  /**
   * Extra indexed fields to carry on every record, as Upstash Search schema builders — e.g.
   * `{ source: s.string().noTokenize(), deleted: s.boolean() }`. The store's `metadata` type is
   * derived from what you declare here, so `add` and the `filter` on {@link AgentMemory.recall},
   * {@link AgentMemory.list} and {@link AgentMemory.count} are all checked against these fields and
   * their types — there is no second type to keep in sync.
   *
   * **Give an extended store its own `prefix`.** The schema describes an index, and an index covers
   * a keyspace: pointing a stricter schema at a keyspace that already holds records written without
   * these fields makes those records permanently invisible, because Upstash Search does not match a
   * missing field against `{$eq: …}` and has no `$ne`. Its own prefix means its own keyspace and its
   * own index, and nothing written earlier is in scope.
   *
   * Omit it and this is exactly the store it always was — same two indexed fields, same index, no
   * re-index, existing records untouched.
   */
  metadataSchema?: TSchema & MetadataSchemaShape<TSchema>;
  /** Default relevance floor for {@link AgentMemory.recall}: BM25, so keyword results only. */
  minScore?: number;
  /**
   * Report the sdk name + version to Upstash as a header on the requests made by your redis client.
   * Can also be disabled with the `UPSTASH_DISABLE_TELEMETRY` env var. Defaults to `true`.
   */
  enableTelemetry?: boolean;
}

/** The two fields every store indexes: the text (keyword + semantic) and the tenant filter. */
const BASE_FIELDS = { text: s.hybrid(), userId: s.string().noTokenize() };
const MemorySchema = s.object(BASE_FIELDS);

/**
 * Long-term agent memory backed entirely by Upstash Redis Search. You pass only the `redis` client;
 * the index is created on the first read and exposed via {@link AgentMemory.searchIndex}.
 *
 * Each memory is one JSON doc at `<prefix>:<userId>:<id>`, scoped per user by an exact-match
 * `userId` filter. Recall with a query is hybrid: keyword (`$smart`) and semantic (`$ann`) results
 * merged with `$rrf`; Upstash Redis Search embeds the text itself.
 */
export class AgentMemory<
  TSchema = EmptySchema,
  TMetadata extends MetadataOf<TSchema> = MetadataOf<TSchema>,
> {
  private redis: Redis;
  private keyPrefix: string;
  private index: ReactiveSearchIndex<typeof MemorySchema>;
  private minScore: number;
  private metadataFields: string[];
  /** In the shared index, the filter that keeps chat rows out of every memory query. */
  private notChat: Record<string, unknown>;

  constructor(config: AgentMemoryConfig<TSchema>) {
    this.redis = config.redis;
    addTelemetry(config.redis, { enabled: config.enableTelemetry });
    const shared =
      config.prefix === undefined &&
      config.indexName === undefined &&
      config.metadataSchema === undefined;
    const prefix = config.prefix ?? SHARED_MEMORY_PREFIX;
    this.keyPrefix = `${prefix}:`;
    this.metadataFields = Object.keys(config.metadataSchema ?? {});
    // Search has no `$ne`, and memories carry no `kind`, hence `$mustNot`.
    this.notChat = shared ? { $mustNot: [{ kind: { $eq: "chat" } }] } : {};
    const schema = shared
      ? (SharedSchema as unknown as typeof MemorySchema)
      : config.metadataSchema === undefined
        ? MemorySchema
        : // `s.object` cannot check a generic `TSchema` against its own self-referential parameter
          // constraint; `metadataSchema`'s type has already enforced that every value is a builder.
          (s.object({
            ...BASE_FIELDS,
            ...(config.metadataSchema as Record<string, never>),
          }) as typeof MemorySchema);
    this.index = new ReactiveSearchIndex({
      redis: this.redis,
      // Index names must be identifier-safe; the key prefix keeps the human-readable base prefix.
      indexName: shared
        ? SHARED_INDEX_NAME
        : (config.indexName ?? prefix.replace(/[^a-zA-Z0-9_]/g, "_")),
      prefix: shared ? SHARED_PREFIXES : this.keyPrefix,
      schema,
      ...(config.enableTelemetry !== undefined ? { enableTelemetry: config.enableTelemetry } : {}),
    });
    this.minScore = config.minScore ?? 0;
  }

  /** The underlying (reactive) Upstash Redis Search index handle. */
  get searchIndex() {
    return this.index;
  }

  private keyFor(userId: string, id: string): string {
    return `${this.keyPrefix}${userId}:${id}`;
  }

  /**
   * Store a memory for `userId` (required, non-empty — unique per user). Returns the persisted record.
   * Key: `<prefix>:<userId>:<id>`. Writes go straight to Redis; the index is created on first recall.
   */
  async add(params: {
    text: string;
    userId: string;
    id?: string;
    metadata?: TMetadata;
  }): Promise<MemoryRecord<TMetadata>> {
    const { text, userId } = params;
    assertUserId(userId);
    const record: MemoryRecord<TMetadata> = {
      id: params.id ?? randomUUID(),
      text,
      createdAt: now(),
      ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
    };
    // `metadata` is spread **top-level**: Redis Search indexes JSON fields by path, so a nested
    // object would not be filterable. `createdAt` still rides along unindexed.
    await this.redis.json.set(this.keyFor(userId, record.id), "$", {
      text,
      userId,
      createdAt: record.createdAt,
      ...(record.metadata ?? {}),
    });
    return record;
  }

  /**
   * Recall the memories most relevant to `query` for `userId`: keyword (`$smart`) and semantic
   * (`$ann`) results merged with `$rrf`. If the hybrid query fails, recall falls back to keyword once.
   * Omit `query` (or pass an empty string) to return the user's memories, unranked.
   *
   * `minScore` applies to keyword results only (hybrid scores are on another scale).
   */
  async recall(params: {
    userId: string;
    query?: string;
    topK?: number;
    minScore?: number;
    /** Extra clauses over {@link AgentMemoryConfig.metadataSchema} fields, e.g. `{source: {$eq: "agent"}}`. */
    filter?: MetadataFilter<TSchema>;
  }): Promise<RecalledMemory<TMetadata>[]> {
    const { userId, query } = params;
    assertUserId(userId);
    const topK = params.topK ?? 5;
    const filter = this.filterFor(userId, params.filter);
    if (!query || !query.trim()) return this.run(filter, topK, userId);
    try {
      return await this.run(
        {
          $rrf: {
            retrievers: [
              { ...filter, text: { $smart: query } },
              { $ann: { field: "text", query, filter } },
            ],
          },
        },
        topK,
        userId,
      );
    } catch {
      const minScore = params.minScore ?? this.minScore;
      const hits = await this.run({ ...filter, text: { $smart: query } }, topK, userId);
      return hits.filter((h) => h.score >= minScore);
    }
  }

  /**
   * Records matching a metadata filter, unranked — the filter-first read, where {@link
   * AgentMemory.recall} is the relevance-first one. Ordering is the caller's business: sort the
   * result by whatever fields they put in `metadata`.
   */
  async list(params: {
    userId: string;
    filter?: MetadataFilter<TSchema>;
    limit?: number;
  }): Promise<RecalledMemory<TMetadata>[]> {
    assertUserId(params.userId);
    return this.run(
      this.filterFor(params.userId, params.filter),
      params.limit ?? 100,
      params.userId,
    );
  }

  /** How many records match, without fetching them. */
  async count(params: { userId: string; filter?: MetadataFilter<TSchema> }): Promise<number> {
    assertUserId(params.userId);
    // Asserted like the query in `run` below: the index may cover more fields than its typed schema.
    const result = await this.index.count({
      filter: this.filterFor(params.userId, params.filter) as never,
    });
    // A missing index answers `{count: -1}`; the reactive wrapper creates it and retries, so a
    // negative here means "genuinely nothing", not "not provisioned".
    return typeof result?.count === "number" && result.count > 0 ? result.count : 0;
  }

  /** The `userId` scope, the caller's metadata clauses, and (in the shared index) "not a chat". */
  private filterFor(userId: string, extra?: MetadataFilter<TSchema>): Record<string, unknown> {
    return { userId: { $eq: userId }, ...(extra ?? {}), ...this.notChat };
  }

  /**
   * Run a query and normalize the rows back into records. The handle is typed with the base schema
   * while the index may cover more fields (metadata, the shared schema), so the query is asserted.
   */
  private async run(
    filter: Record<string, unknown>,
    limit: number,
    userId: string,
  ): Promise<RecalledMemory<TMetadata>[]> {
    const rows = (await this.index.query({
      filter: filter as InferFilterFromSchema<typeof MemorySchema>,
      limit,
    })) as unknown as {
      key: string;
      score: number;
      data?: Record<string, unknown>;
    }[];
    const idPrefix = this.keyFor(userId, "");
    return rows.map((r) => ({
      ...this.toRecord(
        r.key.startsWith(idPrefix) ? r.key.slice(idPrefix.length) : r.key,
        r.data ?? {},
      ),
      score: r.score,
    }));
  }

  /** Rebuild a stored document into a record. Metadata is stored flat so it can be indexed. */
  private toRecord(id: string, data: Record<string, unknown>): MemoryRecord<TMetadata> {
    const metadata = Object.fromEntries(
      this.metadataFields.filter((f) => data[f] !== undefined).map((f) => [f, data[f]]),
    ) as TMetadata;
    return {
      id,
      text: typeof data.text === "string" ? data.text : "",
      createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
      ...(this.metadataFields.length > 0 ? { metadata } : {}),
    };
  }

  /**
   * One memory by id, or `null` if there is none.
   *
   * This reads the key directly rather than going through the index, which is the point: a search
   * returns a bounded, unordered page, so looking a known id up by listing and filtering can miss a
   * record that exists purely because it fell outside the page. It also sees records the index has
   * not caught up with yet, and records a `filter` would have excluded.
   */
  async get(params: { userId: string; id: string }): Promise<MemoryRecord<TMetadata> | null> {
    assertUserId(params.userId);
    const data = (await this.redis.json.get(this.keyFor(params.userId, params.id))) as Record<
      string,
      unknown
    > | null;
    if (data === null || typeof data !== "object") return null;
    return this.toRecord(params.id, data);
  }

  /** Delete a memory by id for `userId` (required, non-empty). */
  async forget(id: string, opts: { userId: string }): Promise<void> {
    const { userId } = opts;
    assertUserId(userId);
    await this.redis.del(this.keyFor(userId, id));
  }
}
