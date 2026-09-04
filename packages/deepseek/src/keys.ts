/**
 * Redis key layout for the DeepSeek Harness session-persistence backend.
 *
 * Three key shapes live under one configurable prefix:
 *
 * ```
 * <prefix>:store                 # string  — this store's identity (SET NX once)
 * <prefix>:ids                   # set     — every materialized session id
 * <prefix>:meta:<id>             # hash    — { meta, incarnation, revision }
 * <prefix>:events:<id>           # list    — one JSON-encoded SessionEvent per element
 * ```
 *
 * The events LIST is the load-bearing choice: a session log is append-only with
 * contiguous `seq` starting at 0, so **list index === event seq**. That makes
 * `LLEN` the stored next-seq, `LRANGE key fromSeq -1` a real seek read (so this
 * backend implements the optional `loadStoredFrom` hook rather than taking the
 * coordinator's parse-everything fallback), and `LTRIM` a tail truncation.
 *
 * @module @upstash/agentkit-deepseek/keys
 */

import type { SessionId } from "@deepseek-ai/dsh-session";

/** Default base prefix for every key this backend owns. */
export const DEFAULT_PREFIX = "dsh:session";

/**
 * The per-store key set, resolved once from a configured prefix.
 *
 * A prefix is the isolation boundary: two backends pointed at the same Redis
 * database with different prefixes share nothing, including store identity, so
 * their revisions can never compare equal.
 */
export interface SessionKeys {
  /** The configured base prefix, verbatim. */
  readonly prefix: string;
  /** Holds this store's generated identity. */
  readonly store: string;
  /** Set of every materialized session id. */
  readonly ids: string;
  /** Hash of one session's header, incarnation, and revision counter. */
  meta(id: SessionId | string): string;
  /** List of one session's JSON-encoded events, indexed by seq. */
  events(id: SessionId | string): string;
}

/**
 * Build the key set for a prefix.
 * @param prefix - base prefix; defaults to {@link DEFAULT_PREFIX}.
 * @returns the resolved key set.
 */
export function sessionKeys(prefix: string = DEFAULT_PREFIX): SessionKeys {
  return {
    prefix,
    store: `${prefix}:store`,
    ids: `${prefix}:ids`,
    meta: (id) => `${prefix}:meta:${String(id)}`,
    events: (id) => `${prefix}:events:${String(id)}`,
  };
}
