/**
 * Encoding and load-time scanning for stored session records.
 *
 * `@upstash/redis` deserializes responses by default (`automaticDeserialization`),
 * so a JSON string written into a list comes back already parsed. Every decoder
 * here therefore accepts BOTH shapes — the parsed object and the raw text — and
 * never assumes which one the client handed back.
 *
 * @module @upstash/agentkit-deepseek/records
 */

import type { SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session";

/** Result of scanning one session's stored records, mirroring the seam's crash contract. */
export interface ScannedRecords {
  /** The valid contiguous prefix, ready for the coordinator to validate and freeze. */
  preserved: SessionEvent[];
  /** First seq of a never-committed tail, when one exists. */
  tornFrom?: number;
}

/** Encode one event for storage. */
export function encodeEvent(event: SessionEvent): string {
  return JSON.stringify(event);
}

/** Encode a session header for storage. */
export function encodeHeader(meta: SessionHeader): string {
  return JSON.stringify(meta);
}

/**
 * Decode a stored value that may arrive parsed or as raw JSON text.
 * @param value - the value Redis returned.
 * @returns the decoded object, or `undefined` when it is absent or not an object.
 */
function decodeObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }
  return typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/**
 * Decode a stored session header.
 * @param value - the raw or parsed header from the meta hash.
 * @returns the header, or `undefined` when it is absent or malformed.
 */
export function decodeHeader(value: unknown): SessionHeader | undefined {
  const object = decodeObject(value);
  if (object === undefined) return undefined;
  if (typeof object["id"] !== "string") return undefined;
  if (typeof object["version"] !== "number") return undefined;
  if (typeof object["createdAt"] !== "number") return undefined;
  return object as unknown as SessionHeader;
}

/**
 * Decode one stored event record.
 *
 * Structural validation stays deliberately shallow — the same depth the SQLite
 * backend's row decode applies. Full validation belongs to the coordinator,
 * which owns it for every backend; this only has to separate "a readable
 * record" from "a hole", because that distinction decides crash repair.
 *
 * @param value - the raw or parsed record from the events list.
 * @returns the event, or `undefined` when the record is a hole.
 */
export function decodeEvent(value: unknown): SessionEvent | undefined {
  const object = decodeObject(value);
  if (object === undefined) return undefined;
  if (typeof object["type"] !== "string") return undefined;
  if (typeof object["seq"] !== "number" || !Number.isSafeInteger(object["seq"])) return undefined;
  if (typeof object["time"] !== "number") return undefined;
  if (!("data" in object)) return undefined;
  return object as unknown as SessionEvent;
}

/**
 * Find the preserved prefix of one session's ordered records.
 *
 * This is the Redis twin of the SQLite backend's row scan, and it enforces the
 * same seam rule: a hole at or before the last valid `turn/end` is committed
 * corruption and rejects, while a hole after it is a tolerated crash tail whose
 * first seq becomes the truncation point.
 *
 * Because the events key is a list indexed by seq, a "hole" here can only be an
 * unreadable record — a seq gap is structurally impossible unless the key was
 * edited outside this backend, which the index check below still catches.
 *
 * @param records - one session's stored records in list order.
 * @param base - the seq the first record must carry (`0` for a whole log, the
 *   requested `fromSeq` for a suffix read).
 * @returns the preserved events, plus `tornFrom` when a torn tail exists.
 */
export function scanRecords(records: readonly unknown[], base = 0): ScannedRecords {
  const decoded = records.map((record) => decodeEvent(record));

  // The last readable `turn/end` closes the committed region: everything at or
  // before it must be intact, everything after it may be crash debris.
  let lastTurnEnd = -1;
  for (let i = decoded.length - 1; i >= 0; i--) {
    if (decoded[i]?.type === "turn/end") {
      lastTurnEnd = i;
      break;
    }
  }

  const preserved: SessionEvent[] = [];
  for (let i = 0; i < decoded.length; i++) {
    const event = decoded[i];
    if (event === undefined) {
      if (i <= lastTurnEnd) {
        throw new Error(`corrupt session log: unreadable committed event at index ${base + i}`);
      }
      break;
    }
    if (event.seq !== base + i) {
      if (i <= lastTurnEnd) {
        throw new Error(
          `corrupt session log: seq gap in committed region (expected ${base + i}, got ${event.seq})`,
        );
      }
      break;
    }
    preserved.push(event);
  }

  return preserved.length < records.length
    ? { preserved, tornFrom: base + preserved.length }
    : { preserved };
}
