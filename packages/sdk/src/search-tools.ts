import { z } from "zod";
import type { InferFilterFromSchema, Redis } from "@upstash/redis";
import { ReactiveSearchIndex, type AnySearchSchema } from "./reactive-index.js";

export interface SearchToolDefsConfig<TSchema extends AnySearchSchema = AnySearchSchema> {
  /** The Upstash Redis Search schema (built with `s` from `@upstash/redis`). */
  schema: TSchema;
  /** Upstash Redis client. */
  redis: Redis;
  /** Index name. Defaults to `"agentkit:search"`. */
  indexName?: string;
  /** Key prefix for indexed JSON documents. Defaults to `"<indexName>:"`. */
  prefix?: string;
  /** Default page size for the `search` tool. Defaults to 10. */
  defaultLimit?: number;
}

/** One framework-agnostic search-tool definition (wrap with AI SDK `tool()` or eve `defineTool()`). */
export interface SearchToolDef {
  description: string;
  inputSchema: z.ZodTypeAny;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
}

/** The three search-tool definitions over one index: `search`, `aggregate`, `count`. */
export interface SearchToolDefs {
  search: SearchToolDef;
  aggregate: SearchToolDef;
  count: SearchToolDef;
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
  return fields.map((f) => `- \`${f.path}\` (${f.type}): ${operatorsFor(f.type)}`).join("\n");
}

const FILTER_GUIDE = [
  "The `filter` is an Upstash Redis Search filter object. Match a field by nesting an operator:",
  '`{ "title": { "$smart": "wireless hedphones" } }` (fuzzy), `{ "price": { "$lt": 100 } }`,',
  '`{ "inStock": { "$eq": true } }`, `{ "category": { "$in": ["a", "b"] } }`.',
  "Combine conditions with `$and` / `$or` / `$must` / `$should` / `$mustNot` (each takes an array):",
  '`{ "$and": [{ "price": { "$gte": 10 } }, { "title": { "$smart": "lamp" } }] }`.',
].join(" ");

/**
 * Build the framework-agnostic `search` / `aggregate` / `count` tool definitions over an Upstash Redis
 * Search index. Each returned def is `{ description, inputSchema (zod), execute }`; the AI SDK adapter
 * wraps them with `tool()` and the eve adapter with `defineTool()`. Descriptions are generated from the
 * `schema` so the model learns the fields, their types, and which filter operators apply.
 *
 * The index is provisioned **reactively**: each op runs straight away, and only if the index doesn't
 * exist yet does it get created (+ `waitIndexing`) and the op retried — see {@link withIndex}.
 */
export function createSearchToolDefs<TSchema extends AnySearchSchema = AnySearchSchema>(
  config: SearchToolDefsConfig<TSchema>,
): SearchToolDefs {
  const { redis, schema } = config;
  const indexName = config.indexName ?? "agentkit:search";
  const prefix = config.prefix ?? `${indexName}:`;
  const defaultLimit = config.defaultLimit ?? 10;
  // The index is provisioned reactively on first read; writes (your seeding) need no index.
  const index = new ReactiveSearchIndex({ redis, indexName, prefix, schema });
  // The filter/aggregation objects come from the model (untyped at runtime), so they're cast to the
  // index's real, schema-derived parameter types at the call sites below — not to `never`.
  type Filter = InferFilterFromSchema<TSchema>;
  const fields = describeSchema(schema as Record<string, unknown>);

  const schemaGuide = `\n\nFields:\n${fieldGuide(fields)}\n\n${FILTER_GUIDE}`;
  const filterParam = z
    .record(z.string(), z.unknown())
    .describe(`An Upstash Redis Search filter object.${schemaGuide}`);

  const search: SearchToolDef = {
    description: `Search the "${indexName}" index and return matching documents, ranked by relevance.${schemaGuide}`,
    inputSchema: z.object({
      filter: filterParam,
      limit: z.number().int().positive().max(100).optional().describe("Max rows to return."),
    }),
    execute: (input) =>
      index.query({
        filter: input.filter as Filter,
        limit: (input.limit as number | undefined) ?? defaultLimit,
      }),
  };

  const aggregate: SearchToolDef = {
    description: `Run aggregations over the "${indexName}" index (group, stats, histograms, …).${schemaGuide}`,
    inputSchema: z.object({
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
    }),
    execute: (input) =>
      index.aggregate({
        aggregations: input.aggregations,
        ...(input.filter !== undefined ? { filter: input.filter as Filter } : {}),
      } as Parameters<typeof index.aggregate>[0]),
  };

  const count: SearchToolDef = {
    description: `Count documents in the "${indexName}" index, optionally matching a filter.${schemaGuide}`,
    inputSchema: z.object({
      filter: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(`Optional filter.${schemaGuide}`),
    }),
    execute: (input) => index.count({ filter: (input.filter ?? {}) as Filter }),
  };

  return { search, aggregate, count };
}
