import { s } from "@upstash/redis";
import { describe, expect, it } from "vitest";
import { AgentMemory } from "./memory.js";
import type { MetadataOf } from "./memory.js";

/**
 * Compile-time checks for the `metadataSchema` → `metadata`/`filter` relationship.
 *
 * The assertions are the `@ts-expect-error` markers: `tsc` fails the build on a directive whose
 * error does not occur, so if any of these usages silently became legal, `pnpm typecheck` goes red.
 * Nothing below is executed — the calls live in functions that are never invoked, so no Redis
 * client is needed.
 */
const redis = {} as never;

const SCHEMA = {
  source: s.string().noTokenize(),
  deleted: s.boolean(),
  slot: s.number(),
};

// Declared, not constructed: these checks are about types only, and building one would need a
// live client. The `new AgentMemory(...)` calls further down sit in functions that never run.
declare const memory: AgentMemory<typeof SCHEMA>;

/** The metadata type is derived from the schema: each builder maps to the value it indexes. */
const derived: MetadataOf<typeof SCHEMA> = { source: "agent", deleted: false, slot: 1 };

async function _metadataValuesMustMatchTheirFieldTypes() {
  await memory.add({
    text: "t",
    userId: "u",
    // @ts-expect-error `deleted` is s.boolean(), so a string is not a valid value
    metadata: { source: "agent", deleted: "false", slot: 1 },
  });
  await memory.add({
    text: "t",
    userId: "u",
    // @ts-expect-error `slot` is s.number(), so a string is not a valid value
    metadata: { source: "agent", deleted: false, slot: "1" },
  });
}

async function _metadataKeysMustBeDeclared() {
  await memory.add({
    text: "t",
    userId: "u",
    // @ts-expect-error `nope` is not a field of the declared schema
    metadata: { source: "agent", deleted: false, slot: 1, nope: true },
  });
}

async function _filterKeysMustBeDeclared() {
  // @ts-expect-error `nope` is not a field of the declared schema
  await memory.recall({ userId: "u", filter: { nope: { $eq: "x" } } });
  // @ts-expect-error `nope` is not a field of the declared schema
  await memory.list({ userId: "u", filter: { nope: { $eq: "x" } } });
  // @ts-expect-error `nope` is not a field of the declared schema
  await memory.count({ userId: "u", filter: { nope: { $eq: "x" } } });
}

async function _filterOperandsMustMatchTheirFieldTypes() {
  // @ts-expect-error `deleted` is a BOOL field, so it cannot be compared against a string
  await memory.recall({ userId: "u", filter: { deleted: { $eq: "false" } } });
  // @ts-expect-error `slot` is a numeric field, so it cannot be compared against a string
  await memory.count({ userId: "u", filter: { slot: { $eq: "1" } } });
}

async function _theCorrectShapesAreAccepted() {
  await memory.add({
    text: "t",
    userId: "u",
    metadata: { source: "agent", deleted: false, slot: 1 },
  });
  await memory.recall({
    userId: "u",
    filter: { deleted: { $eq: false }, source: { $eq: "agent" } },
  });
  await memory.count({ userId: "u", filter: { slot: { $gte: 2 } } });
}

function _schemaValuesMustBeFieldBuilders() {
  // @ts-expect-error a raw field object is not one of the `s` builders
  new AgentMemory({ redis, metadataSchema: { source: { type: "TEXT" } } });
  // @ts-expect-error a plain type is not one of the `s` builders
  new AgentMemory({ redis, metadataSchema: { source: "string" } });
}

function _anExplicitMetadataTypeMustComplyWithTheSchema() {
  // The two-argument form exists to narrow a derived type — here `source` from `string` to a union.
  new AgentMemory<typeof SCHEMA, { source: "agent" | "user"; deleted: boolean; slot: number }>({
    redis,
    metadataSchema: SCHEMA,
  });
  new AgentMemory<
    typeof SCHEMA,
    // @ts-expect-error `deleted` is s.boolean(), so it cannot be declared a string
    { source: string; deleted: string; slot: number }
  >({ redis, metadataSchema: SCHEMA });
  new AgentMemory<
    typeof SCHEMA,
    // @ts-expect-error the schema declares `slot`, so a metadata type may not drop it
    { source: string; deleted: boolean }
  >({ redis, metadataSchema: SCHEMA });
}

describe("metadataSchema type safety", () => {
  it("derives the metadata shape from the declared builders", () => {
    // The real assertions are the `@ts-expect-error` markers above, enforced by `pnpm typecheck`.
    expect(derived).toEqual({ source: "agent", deleted: false, slot: 1 });
    // Referenced so the compiler keeps checking them; never called.
    expect(
      [
        _metadataValuesMustMatchTheirFieldTypes,
        _metadataKeysMustBeDeclared,
        _filterKeysMustBeDeclared,
        _filterOperandsMustMatchTheirFieldTypes,
        _theCorrectShapesAreAccepted,
        _schemaValuesMustBeFieldBuilders,
        _anExplicitMetadataTypeMustComplyWithTheSchema,
      ].every((fn) => typeof fn === "function"),
    ).toBe(true);
  });
});
