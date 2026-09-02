/**
 * `redisDocuments()` — an Upstash Redis **storage backend** for eve's built-in `fileMemory()`
 * provider (`eve/memory/file`). Drop-in replacement for the default (Vercel Blob / in-memory)
 * backend, exactly like `vercelBlob()`:
 *
 * ```ts
 * // agent/memory/profile.ts
 * import { defineMemory } from "eve/memory";
 * import { byPrincipal } from "eve/memory/scope";
 * import { fileMemory } from "eve/memory/file";
 * import { redisDocuments } from "@upstash/agentkit-eve/memory";
 *
 * export default defineMemory({
 *   description: "Remember stable facts and preferences about the caller.",
 *   provider: fileMemory({ backend: redisDocuments() }),
 *   scope: byPrincipal,
 * });
 * ```
 *
 * This closes eve's documented gap: with no `backend`, `fileMemory()` resolves to in-memory storage
 * under `eve dev`, to Vercel Blob on Vercel, and **errors everywhere else**. Recall behavior and the
 * `save_memory`/`remove_memory` tools are eve's own and unchanged — only the storage moves.
 *
 * See `./provider.ts` for the other integration, `redisMemory()`, and `./index.ts` for
 * how the two differ and which to pick.
 *
 * ## Optimistic concurrency without WATCH/MULTI (verified, not assumed)
 *
 * `MemoryDocumentBackend.write()` is a conditional replace: it must throw eve's
 * `MemoryDocumentConflictError` when the caller's `expectedVersion` no longer matches the stored
 * one (`fileMemory()` catches it, re-reads, and retries up to 8 times). `@upstash/redis` speaks the
 * **REST** API, which is stateless and therefore has no `WATCH`/`MULTI` — so the compare and the
 * swap have to happen inside a single server-side command.
 *
 * That command is `EVAL`. **Verified live against an Upstash Redis instance** (2026-09, an
 * `upstash start-redis` database on the current REST API), not assumed:
 * - `EVAL` is accepted over the REST API and through `@upstash/redis`'s `redis.eval(script, keys,
 *   args)`, including with auto-pipelining enabled (the default);
 * - a Lua table return (`{0, currentVersion}` / `{1, newVersion}`) round-trips as a JSON array, so
 *   the script can report *why* it refused and what the current version is;
 * - `HGET`/`HSET`/`EXPIRE` inside the script behave normally, and `SCRIPT LOAD` works too.
 *
 * The script ({@link CAS_SCRIPT}) is sent with every write rather than cached as a SHA + `EVALSHA`:
 * it is ~300 bytes, writes are rare (one per `save_memory`/`remove_memory` call), and `EVALSHA`
 * would need a `NOSCRIPT` fallback path for no measurable gain.
 *
 * ## Storage layout
 *
 * One Redis **hash** per eve scope key at `agentkit:memoryFile:<scopeKey>`, with two fields,
 * `content` and `version`. A hash (rather than a JSON string) keeps the Lua script trivial: it
 * compares one field and writes two.
 *
 * The stored `content` carries a short {@link CONTENT_MARKER} prefix, stripped on read. This is not
 * decoration: `@upstash/redis` **auto-deserializes** replies, so a document whose text happens to
 * be valid JSON (`123`, `{"a":1}`) comes back as a `number`/`object` instead of the exact string
 * that was written — measured, not theorized. The marker makes every stored value un-parseable as
 * JSON, which guarantees `read()` returns the document byte-for-byte as `write()` received it.
 * eve's own document format starts with an HTML comment today, but the backend contract is "any
 * UTF-8 string" and a corrupted round-trip would surface as an opaque
 * "Memory backend returned an invalid versioned memory document." much later.
 *
 * The prefix is deliberately *outside* `agentkit:memory:` — that one belongs to `AgentMemory`'s
 * search index, and a document written under it would be indexed as a malformed memory doc.
 */
import { Redis } from "@upstash/redis";
import { MemoryDocumentConflictError } from "eve/memory/file";
import type {
  MemoryDocument,
  MemoryDocumentBackend,
  MemoryDocumentReadInput,
  MemoryDocumentWriteInput,
} from "eve/memory/file";
import { addTelemetry } from "../telemetry.js";

/** Configuration for {@link redisDocuments}. */
export interface RedisDocumentsConfig {
  /**
   * Upstash Redis client.
   *
   * @default Redis.fromEnv()
   */
  redis?: Redis;
  /**
   * Key prefix for the per-scope document hashes.
   *
   * Deliberately **not** under `agentkit:memory:` — that prefix is {@link AgentMemory}'s Redis
   * Search index prefix, and a document written under it would be picked up by that index as a
   * malformed memory doc.
   *
   * @default "agentkit:memoryFile"
   */
  prefix?: string;
  /**
   * Optional expiry, refreshed on every successful write. Omit for durable memory; set it for
   * scopes that should age out (a per-conversation or per-ticket slot, say). Applied inside the
   * same Lua script as the write, so it can never outlive a failed compare-and-set.
   *
   * @default undefined — documents are kept indefinitely
   */
  ttlSeconds?: number;
  /**
   * Report the sdk name + version to Upstash as a header on the requests made by your redis client.
   * Can also be disabled with the `UPSTASH_DISABLE_TELEMETRY` env var.
   *
   * @default true
   */
  enableTelemetry?: boolean;
}

/**
 * Marker prefixed to every stored document. Its only job is to make the stored value invalid JSON
 * so `@upstash/redis`'s automatic reply deserialization hands the string back untouched — see the
 * module docstring.
 */
const CONTENT_MARKER = "eve-memory-document-v1:";

/**
 * Compare-and-set for one document hash, as a single server-side command.
 *
 * `KEYS[1]` = document key. `ARGV` = `[content, expectedVersion, newVersion, ttlSeconds]`, where an
 * empty `expectedVersion` means "create only — the key must not exist" (versions we mint are never
 * empty, and eve rejects an empty version coming back from `read()`, so the empty string is a safe
 * sentinel for `null`).
 *
 * Returns `{1, newVersion}` when the swap happened and `{0, currentVersion}` when it did not; the
 * caller turns the second case into eve's `MemoryDocumentConflictError`. Returning the *current*
 * version rather than a bare `0` keeps the failure debuggable.
 */
const CAS_SCRIPT = `
local current = redis.call('HGET', KEYS[1], 'version')
if current == false then current = '' end
if current ~= ARGV[2] then return {0, current} end
redis.call('HSET', KEYS[1], 'content', ARGV[1], 'version', ARGV[3])
local ttl = tonumber(ARGV[4])
if ttl and ttl > 0 then redis.call('EXPIRE', KEYS[1], ttl) end
return {1, ARGV[3]}
`;

/** How many written scope keys {@link RedisMemoryDocumentBackend} remembers (FIFO). */
const WRITTEN_KEY_MEMO_LIMIT = 1_024;

/** Monotonic-ish, collision-proof opaque version. eve only ever compares versions for equality. */
let versionCounter = 0;
function nextVersion(): string {
  versionCounter += 1;
  return `r${Date.now().toString(36)}-${versionCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/**
 * An Upstash Redis implementation of eve's {@link MemoryDocumentBackend}: one versioned document
 * per scope key, with a real optimistic-concurrency `write()`. Construct it via {@link redisDocuments}.
 */
export class RedisMemoryDocumentBackend implements MemoryDocumentBackend {
  private readonly redis: Redis;
  private readonly prefix: string;
  private readonly ttlSeconds: number;
  /**
   * Scope keys this instance has written, newest last. Used only to tell a document that is
   * *genuinely* absent from one this backend knows it wrote — see {@link read}. Bounded so a
   * long-lived server with many scopes can't grow it without limit; evicting an entry only costs a
   * confirming re-read that would have happened anyway.
   */
  private readonly written = new Set<string>();

  constructor(config: RedisDocumentsConfig = {}) {
    this.redis = config.redis ?? Redis.fromEnv();
    addTelemetry(this.redis, config.enableTelemetry);
    this.prefix = config.prefix ?? "agentkit:memoryFile";
    this.ttlSeconds = config.ttlSeconds ?? 0;
  }

  /** The Redis key holding one scope's document. eve's scope key is already an opaque digest. */
  keyFor(scopeKey: string): string {
    return `${this.prefix}:${scopeKey}`;
  }

  /**
   * One `HMGET` of the document hash, normalized to eve's {@link MemoryDocument} or `null`.
   *
   * The fields are typed `unknown` on purpose — do not "tighten" them to `string`. `@upstash/redis`
   * auto-deserializes replies, so a value that parses as JSON comes back as a number/object even
   * though a string was written. {@link CONTENT_MARKER} makes that impossible for `content`, but
   * the type has to describe what the client can actually return, and the `typeof` guards below
   * are what turn it back into a document.
   */
  private async load(key: string): Promise<MemoryDocument | null> {
    const stored = await this.redis.hmget<{ content?: unknown; version?: unknown }>(
      this.keyFor(key),
      "content",
      "version",
    );
    if (!stored) return null;
    const { content, version } = stored;
    // A half-written hash can't happen (both fields are set by one script), but a manually edited
    // key could produce one; treat anything unusable as "no document" rather than crashing the turn.
    if (typeof content !== "string" || typeof version !== "string" || version.length === 0) {
      return null;
    }
    return { content: decodeContent(content), version };
  }

  /**
   * Read the document for a scope key.
   *
   * A plain `HMGET` is not quite enough: an Upstash database replicates, and `@upstash/redis`'s
   * read-your-writes guarantee is carried by an `upstash-sync-token` header that **lags one request
   * behind** in 1.38.0 — `HttpClient.request()` merges the outgoing headers *before* it copies the
   * latest token into them, so every request is sent with the token from one response ago. A read
   * issued right after a write therefore travels without the token that would force the replica to
   * catch up, and can report the document as absent. It is a race, not a certainty: the replica is
   * usually current within the round trip, which is why this only ever surfaced as a rare CI failure
   * and never locally.
   *
   * Reporting a document we just wrote as absent is the one wrong answer here — eve's `fileMemory()`
   * would start a *fresh* document and write it with `expectedVersion: null`, taking a conflict and a
   * retry (it recovers, but that is a wasted round trip built on a lie). So when the store says
   * "absent" for a key **this instance has written**, confirm it: each extra request also flushes the
   * correct sync token into the client's headers, so the retry is the request that carries it.
   * Genuinely absent documents (a fresh scope, or one whose `ttlSeconds` expired) still resolve to
   * `null` — the common "no document yet" path costs exactly one round trip, as before.
   */
  read = async ({ key, signal }: MemoryDocumentReadInput): Promise<MemoryDocument | null> => {
    signal.throwIfAborted();
    const document = await this.load(key);
    if (document !== null || !this.written.has(key)) return document;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      signal.throwIfAborted();
      const confirmed = await this.load(key);
      if (confirmed !== null) return confirmed;
    }
    // Really gone (expired via `ttlSeconds`, or deleted out from under us) — stop second-guessing it.
    this.written.delete(key);
    return null;
  };

  write = async ({
    content,
    expectedVersion,
    key,
    signal,
  }: MemoryDocumentWriteInput): Promise<MemoryDocument> => {
    signal.throwIfAborted();
    const version = nextVersion();
    // REST has no WATCH/MULTI, so the compare and the swap happen inside one Lua script — see the
    // module docstring for the live verification that EVAL works on Upstash's REST API.
    const [ok] = await this.redis.eval<string[], [number, string]>(
      CAS_SCRIPT,
      [this.keyFor(key)],
      [`${CONTENT_MARKER}${content}`, expectedVersion ?? "", version, String(this.ttlSeconds)],
    );
    // Someone else wrote between the caller's read and this write. eve's `fileMemory()` catches
    // this exact error, re-reads and retries — so it must be *this* error, not a generic one.
    if (ok !== 1) throw new MemoryDocumentConflictError(key);
    // Remember that this key exists so a read racing this write can't be fooled into reporting it
    // absent (see `read`). Bounded FIFO — Sets iterate in insertion order.
    if (this.written.size >= WRITTEN_KEY_MEMO_LIMIT) {
      const oldest = this.written.values().next();
      if (!oldest.done) this.written.delete(oldest.value);
    }
    this.written.add(key);
    return { content, version };
  };
}

/** Strip the storage marker; tolerate values written before/without it. */
function decodeContent(stored: string): string {
  return stored.startsWith(CONTENT_MARKER) ? stored.slice(CONTENT_MARKER.length) : stored;
}

/**
 * An Upstash Redis document backend for eve's `fileMemory()`. Drop-in replacement for the default
 * (Vercel Blob / in-memory) backend and for `vercelBlob()`:
 *
 * ```ts
 * provider: fileMemory({ backend: redisDocuments() })
 * ```
 *
 * This is what makes `fileMemory()` work off Vercel — without a `backend` it errors outside
 * `eve dev` and Vercel-with-Blob. Recall behavior and the `save_memory`/`remove_memory` tools are
 * unchanged; only the storage moves.
 */
export function redisDocuments(config: RedisDocumentsConfig = {}): MemoryDocumentBackend {
  return new RedisMemoryDocumentBackend(config);
}
