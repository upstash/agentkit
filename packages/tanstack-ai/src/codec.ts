/**
 * Value codec for everything this package stores. `@upstash/redis` auto-deserializes replies, so a
 * stored string that happens to be valid JSON (`"123"`, `"null"`) would come back as a different type.
 * Every value is written as `j:` + JSON, which never parses as JSON, so reads are byte-exact.
 */
const MARK = "j:";

export function encode(value: unknown): string {
  // `undefined` has no JSON form; store it as null so the field still round-trips as "present".
  return MARK + JSON.stringify(value === undefined ? null : value);
}

export function decode<T>(raw: unknown): T {
  if (typeof raw !== "string" || !raw.startsWith(MARK)) {
    throw new Error("@upstash/agentkit-tanstack-ai: stored value is not in the expected format.");
  }
  return JSON.parse(raw.slice(MARK.length)) as T;
}

/** Encode each defined field of a record, for `HSET`. */
export function encodeFields(record: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) if (v !== undefined) out[k] = encode(v);
  return out;
}

/** Decode a `HGETALL` reply back into a record; `null` for a missing hash. */
export function decodeFields<T>(raw: Record<string, unknown> | null | undefined): T | null {
  if (!raw || Object.keys(raw).length === 0) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = decode(v);
  return out as T;
}

/** Reject ids that would break a key: empty, or carrying CR/LF. */
export function assertId(value: string, name: string): void {
  if (typeof value !== "string" || value === "" || /[\r\n]/.test(value)) {
    throw new Error(`@upstash/agentkit-tanstack-ai: \`${name}\` must be a non-empty string.`);
  }
}
