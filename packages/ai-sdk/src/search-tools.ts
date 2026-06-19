import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { Redis } from "@upstash/redis";
import { withIndex } from "@upstash/agentkit-sdk";

/** The schema type accepted by `redis.search.index` (an `s.object({...})`). */
type SearchSchema = NonNullable<Parameters<Redis["search"]["index"]>[0]["schema"]>;

export interface CreateSearchToolsConfig {
  /** The Upstash Redis Search schema (built with `s` from `@upstash/redis`). */
  schema: SearchSchema;
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /** Index name. Defaults to `"agentkit:search"`. */
  name?: string;
  /** Key prefix for indexed JSON documents. Defaults to `"<name>:"`. */
  prefix?: string;
  /** Create the index if it doesn't exist yet (idempotent). Defaults to `true`. */
  ensureIndex?: boolean;
  /** Default page size for the `search` tool. Defaults to 10. */
  defaultLimit?: number;
}

interface FieldInfo {
  path: string;
  type: string;
}

/** Walk an Upstash search schema into a flat list of `{ path, type }` field descriptors. */
function describeSchema(schema: Record<string, unknown>, prefix = ""): FieldInfo[] {
  const out: FieldInfo[] = [];
  for (const [key, value] of Object.entries(schema)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") {
      const type = (value as { type?: unknown }).type;
      if (typeof type === "string") out.push({ path, type });
      else out.push(...describeSchema(value as Record<string, unknown>, path));
    }
  }
  return out;
}

/** Operators applicable to each Upstash field type, for the tool description. */
function operatorsFor(type: string): string {
  switch (type) {
    case "TEXT":
      return "`$smart` (typo-tolerant fuzzy match — preferred for free text), `$phrase`, `$fuzzy`, `$regex`, `$eq`";
    case "F64":
      return "`$eq`, `$lt`, `$lte`, `$gt`, `$gte`, `$range` ({ gte, lte }), `$in`";
    case "DATE":
      return "`$eq`, `$lt`, `$lte`, `$gt`, `$gte`, `$range`";
    case "BOOL":
      return "`$eq`";
    case "KEYWORD":
    case "FACET":
      return "`$eq`, `$in` (exact match)";
    default:
      return "`$eq`";
  }
}

function fieldGuide(fields: FieldInfo[]): string {
  const lines = fields.map((f) => `- \`${f.path}\` (${f.type}): ${operatorsFor(f.type)}`);
  return lines.join("\n");
}

const FILTER_GUIDE = [
  "The `filter` is an Upstash Redis Search filter object. Match a field by nesting an operator:",
  '`{ "title": { "$smart": "wireless hedphones" } }` (fuzzy), `{ "price": { "$lt": 100 } }`,',
  '`{ "inStock": { "$eq": true } }`, `{ "category": { "$in": ["a", "b"] } }`.',
  "Combine conditions with `$and` / `$or` / `$must` / `$should` / `$mustNot` (each takes an array):",
  '`{ "$and": [{ "price": { "$gte": 10 } }, { "title": { "$smart": "lamp" } }] }`.',
].join(" ");

/**
 * Build a set of Vercel AI SDK tools that let an agent search an Upstash Redis Search index:
 * `search` (query), `aggregate`, and `count`. The tool descriptions are generated from your `schema`
 * so the model knows the available fields, their types, and which filter operators apply to each.
 *
 * ```ts
 * import { s } from "@upstash/redis";
 * import { createSearchTools } from "@upstash/agentkit-ai-sdk";
 * import { generateText, stepCountIs } from "ai";
 *
 * const schema = s.object({ name: s.string(), age: s.number() });
 * const result = await generateText({
 *   model,
 *   tools: createSearchTools({ schema, name: "users" }),
 *   stopWhen: stepCountIs(5),
 *   prompt: "Find users named Ada older than 30",
 * });
 * ```
 */
export function createSearchTools(config: CreateSearchToolsConfig): ToolSet {
  const redis = config.redis ?? Redis.fromEnv();
  const name = config.name ?? "agentkit:search";
  const prefix = config.prefix ?? `${name}:`;
  const defaultLimit = config.defaultLimit ?? 10;
  const ensureIndex = config.ensureIndex ?? true;
  const index = redis.search.index({ name, schema: config.schema });
  const fields = describeSchema(config.schema as Record<string, unknown>);

  /** Create the index (idempotent) and wait until it's queryable — the missing-index recovery path. */
  const provision = async (): Promise<void> => {
    await redis.search
      .createIndex({ name, dataType: "json", prefix, schema: config.schema })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/already exists/i.test(msg)) throw err;
      });
    await index.waitIndexing();
  };

  /**
   * Run a tool's index op; if the index doesn't exist yet, create it (+ `waitIndexing`) and retry.
   * A missing Upstash index surfaces differently per op — `query`→`null`, `count`→`{ count: -1 }`,
   * `aggregate`→throws — so we pass the right `isMissingResult` sentinel for each. When `ensureIndex`
   * is `false`, the op runs raw with no recovery.
   */
  const runOp = <T>(op: () => Promise<T>, isMissingResult?: (r: T) => boolean): Promise<T> =>
    ensureIndex ? withIndex(provision, op, isMissingResult) : op();

  const schemaGuide = `\n\nFields:\n${fieldGuide(fields)}\n\n${FILTER_GUIDE}`;

  const filterParam = z
    .record(z.string(), z.unknown())
    .describe(`An Upstash Redis Search filter object.${schemaGuide}`);

  const searchInput = z.object({
    filter: filterParam,
    limit: z.number().int().positive().max(100).optional().describe("Max rows to return."),
  });
  const aggregateInput = z.object({
    aggregations: z
      .record(z.string(), z.unknown())
      .describe(
        'Aggregations object, e.g. `{ "avgAge": { "$avg": { "field": "age" } } }`, ' +
          "or `$terms`/`$histogram` for grouping, `$stats`/`$sum`/`$min`/`$max`/`$count`/`$cardinality`.",
      ),
    filter: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Optional pre-aggregation filter."),
  });
  const countInput = z.object({
    filter: z.record(z.string(), z.unknown()).optional().describe(`Optional filter.${schemaGuide}`),
  });

  const search = tool({
    description: `Search the "${name}" index and return matching documents, ranked by relevance.${schemaGuide}`,
    inputSchema: searchInput,
    execute: ({ filter, limit }) =>
      runOp(
        () =>
          index.query({
            filter: filter as never,
            limit: limit ?? defaultLimit,
          } as never) as Promise<unknown[] | null>,
        (r) => r === null, // missing index → query returns null
      ),
  });

  const aggregate = tool({
    description: `Run aggregations over the "${name}" index (group, stats, histograms, …).${schemaGuide}`,
    inputSchema: aggregateInput,
    // missing index → aggregate throws (caught by withIndex), so no sentinel needed.
    execute: ({ aggregations, filter }) =>
      runOp(() =>
        index.aggregate({
          aggregations,
          ...(filter !== undefined ? { filter } : {}),
        } as never),
      ),
  });

  const count = tool({
    description: `Count documents in the "${name}" index, optionally matching a filter.${schemaGuide}`,
    inputSchema: countInput,
    execute: ({ filter }) =>
      runOp(
        () => index.count({ filter: (filter ?? {}) as never }),
        (r) => (r as { count: number }).count === -1, // missing index → { count: -1 }
      ),
  });

  return { search, aggregate, count };
}
