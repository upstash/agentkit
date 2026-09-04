/**
 * Durable DeepSeek Harness session persistence on Upstash Redis.
 *
 * This is a Service Provider for the `dsh-session-persistence` capability seam:
 * it registers as `ctx.sessionPersistence` and stores each session's
 * `SessionEvent` log plus its out-of-log `SessionHeader` in Redis. Like the
 * SQLite backend, it composes the shared {@link PersistenceCoordinator} and
 * implements only the small `PersistenceBackend` storage-hook interface, so the
 * write-path orchestration the seam specifies — batching, per-id serialization,
 * lazy materialization, crash repair sequencing, session adoption, quiescent
 * disposal — is the same code every first-party backend runs.
 *
 * Redis is a networked store rather than a local artifact, so this backend has
 * no per-session file: `locate()` returns `undefined` and `supportsRawArtifacts`
 * is `false`.
 *
 * @module @upstash/agentkit-deepseek/session-persistence
 */

import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Redis } from "@upstash/redis";
import {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
  MAX_WRITE_BATCH_DELAY_MS,
  PersistenceCoordinator,
  SessionPersistence,
  SessionPersistenceRevision,
  type PersistenceBackend,
  type SessionInspection,
  type SessionLocation,
  type SessionPersistenceSnapshot,
  type StoredPrefix,
  type StoredSuffix,
} from "@deepseek-ai/dsh-session-persistence";
import type {
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionPreparation,
} from "@deepseek-ai/dsh-session";
import { DEFAULT_PREFIX, sessionKeys, type SessionKeys } from "./keys.js";
import { decodeHeader, encodeEvent, encodeHeader, scanRecords } from "./records.js";
import { APPEND_BATCH, COMMIT_REPAIR, READ_LOG, READ_REVISION } from "./scripts.js";
import {
  assertCredentialRef,
  credentialResolverOf,
  DEFAULT_TOKEN_REF,
  DEFAULT_URL_REF,
  resolveConnection,
} from "./credentials.js";

/** Plugin configuration. */
export interface Config {
  /**
   * Redis client. Runtime-only seam — not settable from `cordis.yml`, because a
   * client instance is not a config value. Omit it and the backend resolves the
   * connection through `ctx.credentials`, falling back to `Redis.fromEnv()`.
   */
  redis?: Redis;
  /**
   * Credential reference holding the Upstash REST URL. Names the credential, not
   * the value — the same shape the harness's own adapters use for `apiKeyEnv`,
   * so no secret is ever written into a config row.
   */
  urlRef?: string;
  /** Credential reference holding the Upstash REST token. */
  tokenRef?: string;
  /**
   * Base key prefix owned by this backend. Two backends on the same database
   * with different prefixes share nothing, including store identity, so their
   * revisions can never compare equal.
   */
  prefix?: string;
  /**
   * Optional expiry refreshed on every write, in seconds. Omitted (the default)
   * keeps sessions forever, which is what the seam's append-only contract
   * assumes. Setting it makes stored sessions disappear on their own — fine for
   * ephemeral or preview deployments, and a data-loss risk for anything a user
   * may resume later, because an expired log is gone rather than repairable.
   */
  ttlSeconds?: number;
  /** Maximum cold Session preparations retained for history-to-resume reuse. */
  preparedSessionCacheSize?: number;
  /** Fixed live-event coalescing window; not a backend completion deadline. */
  writeBatchMaxDelayMs?: number;
}

/** Raw shape of one session's stored state, as the read script returns it. */
type ReadLogReply = [unknown, unknown, unknown, unknown[]] | null;

/** Raw shape of one session's revision fields. */
type ReadRevisionReply = [unknown, unknown] | null;

/**
 * Prepare a client's scripts and claim or read this store's generated identity.
 *
 * A module-level factory rather than a method so `ConnectedStore` can be
 * *inferred* from it: `@upstash/redis` does not export its `Script`/`ScriptRO`
 * types, and inferring beats restating them by hand.
 *
 * Revisions must not compare equal across independently backed stores, and a
 * per-session counter alone cannot promise that: two different databases both
 * start at 1. A `SET NX` id, written once per prefix and read back by every
 * later instance, qualifies every revision this backend emits.
 *
 * @param redis - the resolved client.
 * @param keys - the resolved key layout.
 * @returns the client, its prepared scripts, and this store's revision prefix.
 */
async function connectStore(redis: Redis, keys: SessionKeys) {
  const candidate = crypto.randomUUID();
  await redis.set(keys.store, candidate, { nx: true });
  const stored = await redis.get<string>(keys.store);
  if (stored === null || stored === undefined || String(stored).length === 0) {
    throw new Error(`redis session store at "${keys.prefix}" has no store identity`);
  }

  return {
    redis,
    storeIdentity: `redis:prefix:${keys.prefix}:store:${String(stored)}`,
    append: redis.createScript<number>(APPEND_BATCH),
    repair: redis.createScript<number>(COMMIT_REPAIR),
    readLog: redis.createScript<ReadLogReply, true>(READ_LOG, { readonly: true }),
    readRevision: redis.createScript<ReadRevisionReply, true>(READ_REVISION, { readonly: true }),
  };
}

/** A connected client with its prepared scripts and this store's revision prefix. */
type ConnectedStore = Awaited<ReturnType<typeof connectStore>>;

/**
 * The Upstash Redis session-persistence backend. Load it as a plugin; it
 * registers `ctx.sessionPersistence` and (through the coordinator) installs the
 * write-path listeners.
 *
 * The events key is a Redis list whose index is the event seq, which makes this
 * a **seek-capable** backend: `readFrom` reads only the requested suffix via
 * `LRANGE`, instead of parsing the whole log and skipping forward.
 *
 * Its torn-tail marker is the seq to truncate from. In practice this backend
 * never produces one — every mutation is a single Lua script, so a batch is
 * written completely or not at all — but truncation stays implemented so a key
 * damaged from outside the backend is still repairable.
 */
export class RedisSessionPersistence
  extends SessionPersistence
  implements PersistenceBackend<number>
{
  override readonly supportsRawArtifacts = false;

  static inject = ["sessions"];

  static Config: z<Config> = z.object({
    prefix: z.string().default(DEFAULT_PREFIX),
    ttlSeconds: z.number().step(1).min(1),
    // `role('credential-ref')` is how the harness marks a field that names a
    // credential: its settings UI renders those as key controls that write
    // through the credentials domain instead of storing the value inline.
    urlRef: z.string().role("credential-ref").default(DEFAULT_URL_REF),
    tokenRef: z.string().role("credential-ref").default(DEFAULT_TOKEN_REF),
    preparedSessionCacheSize: z
      .number()
      .step(1)
      .min(1)
      .default(DEFAULT_PREPARED_SESSION_CACHE_SIZE),
    writeBatchMaxDelayMs: z
      .number()
      .step(1)
      .min(1)
      .max(MAX_WRITE_BATCH_DELAY_MS)
      .default(DEFAULT_WRITE_BATCH_MAX_DELAY_MS),
  }) as unknown as z<Config>;

  /**
   * Backend label for the coordinator's dispose diagnostics. Intentionally
   * shadows the cordis `Service.name` the base class sets to
   * `'sessionPersistence'`, exactly as the first-party backends do.
   */
  override readonly name = "session-persistence-upstash-redis";

  /** Resolved key layout for the configured prefix. */
  readonly keys: SessionKeys;

  private readonly ttlSeconds: number;
  private readonly urlRef: string;
  private readonly tokenRef: string;
  private readonly coordinator: PersistenceCoordinator<number>;

  /**
   * The connected client, its scripts, and the store-qualified revision prefix.
   *
   * Everything client-shaped lives behind this one promise because resolving the
   * connection is now asynchronous — `ctx.credentials.resolve()` is async, and
   * the credentials document is the layer users are steered toward. Every
   * storage hook already awaited a readiness promise, so the async client costs
   * no extra round trip and no hook had to change shape.
   */
  private readonly ready: Promise<ConnectedStore>;

  constructor(
    ctx: Context,
    public config: Config = {},
  ) {
    super(ctx);
    // Programmatic construction skips Schemastery normalization, so every knob
    // resolves its own default here too.
    this.keys = sessionKeys(config.prefix ?? DEFAULT_PREFIX);
    this.ttlSeconds = config.ttlSeconds ?? 0;
    this.urlRef = assertCredentialRef(config.urlRef ?? DEFAULT_URL_REF);
    this.tokenRef = assertCredentialRef(config.tokenRef ?? DEFAULT_TOKEN_REF);

    // Connect off the constructor's critical path so plugin apply does not wait
    // on credential resolution or a network round trip.
    this.ready = this.connect();

    this.coordinator = new PersistenceCoordinator<number>(this.ctx, this, {
      preparedSessionCacheSize:
        config.preparedSessionCacheSize ?? DEFAULT_PREPARED_SESSION_CACHE_SIZE,
      writeBatchMaxDelayMs: config.writeBatchMaxDelayMs ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
    });
  }

  /**
   * The client every storage hook runs against, once connected.
   *
   * Exposed for callers that want to reach the same database — note it *awaits*,
   * unlike the old synchronous field, because the connection may come from the
   * credentials service.
   */
  get redis(): Promise<Redis> {
    return this.ready.then((store) => store.redis);
  }

  /** Resolve the connection, then prepare scripts and store identity. */
  private async connect(): Promise<ConnectedStore> {
    return connectStore(await this.resolveClient(), this.keys);
  }

  /**
   * Build the Redis client from the highest-precedence source available.
   *
   * Precedence: an explicit client, then `ctx.credentials` (which searches every
   * harness layer, including the `.credentials.yaml` document that never reaches
   * `process.env`), then `Redis.fromEnv()` so a deployment with no credentials
   * provider — or an embedder outside the harness — behaves as it did before.
   */
  private async resolveClient(): Promise<Redis> {
    if (this.config.redis !== undefined) return this.config.redis;

    const resolver = credentialResolverOf(this.ctx);
    if (resolver !== undefined) {
      const connection = await resolveConnection(resolver, this.urlRef, this.tokenRef);
      if (connection !== undefined) {
        return new Redis({ url: connection.url, token: connection.token });
      }
    }

    return Redis.fromEnv();
  }

  /** Build the source-qualified revision shared by full and lightweight reads. */
  private revision(storeIdentity: string, incarnation: unknown, revision: unknown) {
    return SessionPersistenceRevision(
      `${storeIdentity}:incarnation:${String(incarnation)}:revision:${String(revision)}`,
    );
  }

  /** The TTL argument every mutating script takes (`0` disables expiry). */
  private get ttlArg(): string {
    return String(this.ttlSeconds);
  }

  // --- SessionPersistence service API (delegated to the coordinator) ---

  /** Redis holds one keyspace, not an independent local artifact per session. */
  locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined;
  }

  create(meta: SessionHeader): Promise<void> {
    return this.coordinator.create(meta);
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events);
  }

  override prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.coordinator.prepare(id, signal);
  }

  load(id: SessionId): Promise<SessionInspection> {
    return this.coordinator.load(id);
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return this.coordinator.inspect(id, signal);
  }

  readFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.readFrom(id, fromSeq, signal);
  }

  // `list` below serves both the public service method and the backend hook;
  // delegating it to the coordinator would call this hook recursively.

  // --- PersistenceBackend hooks (the Redis storage primitives) ---

  /**
   * Read a stored prefix by id. Session ids are globally unique, so there is one
   * key pair to resolve and no scope to scan.
   */
  async loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<number> | undefined> {
    return this.readLog(id, 0, signal) as Promise<StoredPrefix<number> | undefined>;
  }

  /**
   * Seek-capable suffix read: `LRANGE key fromSeq -1` addresses events by seq
   * directly, so `readFrom` scales with the suffix rather than the log. Records
   * past the preserved region are dropped, never repaired — this read must not
   * mutate.
   */
  async loadStoredFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<StoredSuffix | undefined> {
    const prefix = await this.readLog(id, fromSeq, signal);
    return prefix === undefined ? undefined : { meta: prefix.meta, events: prefix.events };
  }

  /**
   * Read one session's header, events, and revision in a single atomic script.
   *
   * The atomicity matters for the seam's revision contract: the returned
   * revision must identify exactly the returned header and events. Two separate
   * round trips could straddle a concurrent append and hand back a revision that
   * describes a different prefix.
   */
  private async readLog(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<StoredPrefix<number> | undefined> {
    signal?.throwIfAborted();
    const store = await this.ready;
    signal?.throwIfAborted();

    const reply = await store.readLog.evalRo(
      [this.keys.events(id), this.keys.meta(id)],
      [String(fromSeq)],
    );
    signal?.throwIfAborted();
    if (reply === null || reply === undefined) return undefined;

    const [rawHeader, incarnation, revision, records] = reply;
    const meta = decodeHeader(rawHeader);
    if (meta === undefined) {
      throw new Error(`corrupt session log: unreadable header for session "${String(id)}"`);
    }

    const { preserved, tornFrom } = scanRecords(records ?? [], fromSeq);
    return {
      meta,
      events: preserved,
      revision: this.revision(store.storeIdentity, incarnation, revision),
      ...(tornFrom !== undefined ? { tornMarker: tornFrom } : {}),
    };
  }

  /** Read one session's revision without loading its event log. */
  async readStoredRevision(id: SessionId, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const store = await this.ready;
    signal?.throwIfAborted();

    const reply = await store.readRevision.evalRo([this.keys.meta(id)], []);
    if (reply === null || reply === undefined) return undefined;
    return this.revision(store.storeIdentity, reply[0], reply[1]);
  }

  /**
   * Durably append a contiguous batch in ONE script: write the header (the
   * materialization step), push every event, bump the revision, and record the
   * id — or change nothing. The script is the atomicity and durability boundary,
   * so a rejected batch (a seq that does not continue the stored log) leaves the
   * stored log untouched.
   */
  async appendBatch(
    meta: SessionHeader,
    events: readonly SessionEvent[],
    _isMaterialized: boolean,
  ): Promise<void> {
    const store = await this.ready;
    if (events.length === 0) return;

    const first = events[0];
    /* istanbul ignore next -- a non-empty batch always has a first element. */
    if (first === undefined) return;

    await store.append.eval(
      [this.keys.events(meta.id), this.keys.meta(meta.id), this.keys.ids],
      [
        String(first.seq),
        encodeHeader(meta),
        crypto.randomUUID(),
        this.ttlArg,
        String(meta.id),
        ...events.map((event) => encodeEvent(event)),
      ],
    );
  }

  /**
   * Make a crash repair durable in ONE script: truncate the torn tail and append
   * the synthetic closers. The seam does not require this to be atomic; here it
   * is anyway.
   */
  async commitRepair(
    meta: SessionHeader,
    tornMarker: number | undefined,
    closers: readonly SessionEvent[],
  ): Promise<void> {
    const store = await this.ready;
    if (tornMarker === undefined && closers.length === 0) return;

    await store.repair.eval(
      [this.keys.events(meta.id), this.keys.meta(meta.id)],
      [String(tornMarker ?? -1), this.ttlArg, ...closers.map((event) => encodeEvent(event))],
    );
  }

  /** List all materialized sessions' metadata, without parsing any event log. */
  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    const snapshots = await this.listSnapshots(signal);
    return snapshots.map((snapshot) => snapshot.header);
  }

  /**
   * List metadata with a source-qualified revision per session.
   *
   * Snapshots are pipelined rather than read in one script: each revision only
   * has to identify its OWN session, so a cross-session atomic view buys nothing
   * and a script looping over every session would block the server.
   */
  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted();
    const store = await this.ready;
    signal?.throwIfAborted();

    const members = await store.redis.smembers(this.keys.ids);
    signal?.throwIfAborted();
    if (members.length === 0) return [];

    const ids = members.map((member) => String(member));
    const pipeline = store.redis.pipeline();
    for (const id of ids) {
      pipeline.hmget(this.keys.meta(id), "meta", "incarnation", "revision");
    }
    const replies = (await pipeline.exec()) as (Record<string, unknown> | null)[];
    signal?.throwIfAborted();

    const snapshots: SessionPersistenceSnapshot[] = [];
    const stale: string[] = [];
    for (const [index, id] of ids.entries()) {
      const fields = replies[index];
      const header = decodeHeader(fields?.["meta"]);
      if (header === undefined) {
        // The id set outlived its session — only reachable with `ttlSeconds` set
        // or an out-of-band delete. Drop it so listing stays bounded.
        stale.push(id);
        continue;
      }
      snapshots.push({
        header,
        revision: this.revision(store.storeIdentity, fields?.["incarnation"], fields?.["revision"]),
      });
    }

    if (stale.length > 0) await store.redis.srem(this.keys.ids, ...stale);
    return snapshots;
  }
}

export default RedisSessionPersistence;
