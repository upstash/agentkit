import type { Redis } from "@upstash/redis";
import type { RunStatus } from "@tanstack/ai";

/**
 * Shared plumbing for the persistence stores. Records are RedisJSON documents, so values keep their
 * JSON types natively (no per-field encoding) and patches are applied server-side.
 *
 * Every script runs with `allow-key-locking`: Upstash locks only the keys a script declares, and an
 * undeclared key is an error, so each script touches exactly its `KEYS`.
 */
export const KEY_LOCKING = "#!lua flags=allow-key-locking\n";

/**
 * Create a document only if it does not exist yet, add it to every index in KEYS[2..], and return the
 * stored document either way (the idempotent `createOrResume` contract).
 * KEYS: document, indexes… ARGV: document JSON, index score, index member.
 */
export const CREATE = `${KEY_LOCKING}if redis.call("JSON.SET", KEYS[1], "$", ARGV[1], "NX") then
  for i = 2, #KEYS do redis.call("ZADD", KEYS[i], ARGV[2], ARGV[3]) end
end
return redis.call("JSON.GET", KEYS[1])`;

/**
 * Patch an existing document with two JSON merge patches (see {@link toMergePatches}). A missing
 * document is a no-op: `JSON.MERGE` would otherwise create it.
 */
export const PATCH = `${KEY_LOCKING}if redis.call("EXISTS", KEYS[1]) == 0 then return 0 end
redis.call("JSON.MERGE", KEYS[1], "$", ARGV[1])
if ARGV[2] ~= "{}" then redis.call("JSON.MERGE", KEYS[1], "$", ARGV[2]) end
return 1`;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Turn a `{ ...existing, ...patch }`-style patch into merge patches for {@link PATCH}. A merge patch
 * deletes a field set to `null` (how a key present with `undefined` — "clear it" — is expressed) but
 * merges nested objects instead of replacing them, so object-valued fields are cleared by the first
 * patch and set by the second, giving replace semantics.
 */
export function toMergePatches(patch: object): [string, string] {
  const first: Record<string, unknown> = {};
  const second: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) first[field] = null;
    else if (isPlainObject(value)) {
      first[field] = null;
      second[field] = value;
    } else first[field] = value;
  }
  return [JSON.stringify(first), JSON.stringify(second)];
}

/** Read several documents in one round trip, in order, dropping missing ones. */
export async function loadDocs<T>(redis: Redis, keys: string[]): Promise<T[]> {
  if (keys.length === 0) return [];
  const pipe = redis.pipeline();
  for (const key of keys) pipe.json.get(key);
  const rows = (await pipe.exec()) as (T | null)[];
  return rows.filter((row): row is T => row !== null && row !== undefined);
}

/** Reject ids that would break a key: empty, or carrying CR/LF. */
export function assertId(value: string, name: string): void {
  if (typeof value !== "string" || value === "" || /[\r\n]/.test(value)) {
    throw new Error(
      `@upstash/agentkit-tanstack-ai: \`${name}\` must be a non-empty string without CR/LF.`,
    );
  }
}

const RUN_STATUSES: ReadonlySet<string> = new Set<RunStatus>([
  "running",
  "interrupted",
  "completed",
  "failed",
  "aborted",
]);

/** Validate a stored run's status at read time — TanStack's readers act destructively on it. */
export function checkRun<T extends { runId: string; status: unknown }>(record: T | null): T | null {
  if (record === null || record === undefined) return null;
  if (typeof record.status !== "string" || !RUN_STATUSES.has(record.status)) {
    throw new Error(
      `@upstash/agentkit-tanstack-ai: run ${JSON.stringify(record.runId)} has an invalid status.`,
    );
  }
  return record;
}
