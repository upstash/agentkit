import type { Redis } from "@upstash/redis";
import { Redis as RedisClient } from "@upstash/redis";
import {
  SandboxCheckpointConflictError,
  SandboxCheckpointDuplicateIdError,
  SandboxCheckpointError,
  SandboxCheckpointInvalidEntryError,
  SandboxCheckpointNotHeadError,
  SandboxCheckpointParentMismatchError,
  SandboxCheckpointWriterConflictError,
  SandboxCheckpointWriterLostError,
  type ForkCapableSandboxCheckpointStore,
  type SandboxCheckpoint,
  type SandboxCheckpointWriter,
  type SandboxCheckpointWriterLease,
} from "@tanstack/ai-sandbox";
import { addTelemetry } from "../telemetry.js";
import { KEY_LOCKING } from "../persistence/records.js";
import {
  assertValidIdentifier,
  blobKeysOf,
  compareUtf8Bytes,
  validateCheckpoint,
} from "./validate.js";

export interface UpstashSandboxCheckpointStoreConfig {
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /**
   * Base key prefix. Defaults to `agentkit:tanstack`. Use the same `prefix` (and Redis) as
   * `upstashPersistence()`: `forkFromCheckpoint` writes the forked conversation into that
   * persistence's message store, in the same script that creates the fork root.
   */
  prefix?: string;
  /**
   * The `messagesTtlSeconds` you pass to `upstashPersistence()`, so a forked transcript expires like
   * any other. Omit to keep transcripts forever.
   */
  messagesTtlSeconds?: number;
  /** Clock for writer leases. Defaults to `Date.now`. */
  now?: () => number;
  /** How long a writer lease lasts without a renew. @default 120_000 */
  leaseDurationMs?: number;
  /** When the lease holder should renew. Must be below `leaseDurationMs`. @default 45_000 */
  renewAfterMs?: number;
  /** Set `false` to opt out of the telemetry header. */
  enableTelemetry?: boolean;
}

// A writer lease is stored as "<ownerToken>|<fence>|<expiresAt>". Expiry is compared against the
// caller's clock (ARGV), not a Redis TTL, so a lease means the same thing to every host and to an
// injected test clock. The key still gets a generous PX so abandoned threads do not keep it forever.
const WRITER_OK = `local function writerOk(key, token, fence, now)
  local w = redis.call("GET", key)
  if not w then return false end
  local t, f, e = string.match(w, "^([^|]*)|([^|]*)|([^|]*)$")
  return t == token and f == fence and tonumber(e) > tonumber(now)
end
`;

/** KEYS: writer, fence counter. ARGV: now, ownerToken, expiresAt, px. Returns the fence, or -1 if held. */
const ACQUIRE = `${KEY_LOCKING}local w = redis.call("GET", KEYS[1])
if w then
  local e = string.match(w, "|([^|]*)$")
  if e and tonumber(e) > tonumber(ARGV[1]) then return -1 end
end
local fence = redis.call("INCR", KEYS[2])
redis.call("SET", KEYS[1], ARGV[2] .. "|" .. fence .. "|" .. ARGV[3], "PX", ARGV[4])
return fence`;

/** KEYS: writer. ARGV: ownerToken, fence, now, new expiresAt, px. Returns 1, or 0 if the lease is gone. */
const RENEW = `${KEY_LOCKING}${WRITER_OK}if not writerOk(KEYS[1], ARGV[1], ARGV[2], ARGV[3]) then return 0 end
redis.call("SET", KEYS[1], ARGV[1] .. "|" .. ARGV[2] .. "|" .. ARGV[4], "PX", ARGV[5])
return 1`;

/** KEYS: writer. ARGV: ownerToken, fence. Deletes the lease only if it is still this one. */
const RELEASE = `${KEY_LOCKING}local w = redis.call("GET", KEYS[1])
if w and w:sub(1, #ARGV[1] + #ARGV[2] + 2) == ARGV[1] .. "|" .. ARGV[2] .. "|" then
  redis.call("DEL", KEYS[1])
end
return 1`;

/**
 * KEYS: writer, checkpoint doc, thread head, thread index, blob reference counts.
 * ARGV: ownerToken, fence, now, expected head ("" = none), "1" if the parent matches the expected
 * head, checkpoint JSON, createdAt, member ("~" + id), blob keys…
 * Checks run in the reference store's order: writer, duplicate id, stale head, parent.
 */
const APPEND = `${KEY_LOCKING}${WRITER_OK}if not writerOk(KEYS[1], ARGV[1], ARGV[2], ARGV[3]) then return "WRITER_LOST" end
if redis.call("EXISTS", KEYS[2]) == 1 then return "DUPLICATE" end
local head = redis.call("GET", KEYS[3]) or ""
if head ~= ARGV[4] then return "STALE_HEAD:" .. head end
if ARGV[5] ~= "1" then return "PARENT" end
redis.call("SET", KEYS[2], ARGV[6])
redis.call("SET", KEYS[3], ARGV[8])
redis.call("ZADD", KEYS[4], ARGV[7], ARGV[8])
for i = 9, #ARGV do redis.call("HINCRBY", KEYS[5], ARGV[i], 1) end
return "OK"`;

/**
 * KEYS: writer, thread head, checkpoint doc, thread index, blob reference counts.
 * ARGV: ownerToken, fence, now, member ("~" + id).
 */
const DELETE_HEAD = `${KEY_LOCKING}${WRITER_OK}if not writerOk(KEYS[1], ARGV[1], ARGV[2], ARGV[3]) then return "WRITER_LOST" end
if (redis.call("GET", KEYS[2]) or "") ~= ARGV[4] then return "NOT_HEAD" end
local raw = redis.call("GET", KEYS[3])
if not raw then return "MISSING" end
local cp = cjson.decode(raw)
redis.call("DEL", KEYS[3])
redis.call("ZREM", KEYS[4], ARGV[4])
local parent = cp.parentCheckpointId
if type(parent) == "string" and parent ~= "" then
  redis.call("SET", KEYS[2], "~" .. parent)
else
  redis.call("DEL", KEYS[2])
end
local seen = {}
local function unref(key)
  if type(key) ~= "string" or seen[key] then return end
  seen[key] = true
  if redis.call("HINCRBY", KEYS[5], key, -1) <= 0 then redis.call("HDEL", KEYS[5], key) end
end
if type(cp.files) == "table" then
  for _, e in ipairs(cp.files) do if e.kind == "file" then unref(e.blobKey) end end
end
if type(cp.artifacts) == "table" then
  for _, a in ipairs(cp.artifacts) do unref(a.blobKey) end
end
return "OK"`;

/**
 * KEYS: destination writer, source checkpoint doc, destination checkpoint doc, destination head,
 * destination index, blob reference counts, then the destination thread's persistence keys that
 * must be empty: transcript, runs, interrupts, generation runs, artifacts (KEYS[7..11]).
 * ARGV: ownerToken, fence, now, checkpoint JSON, transcript JSON, member, createdAt, ttl ("0" = none),
 * blob keys…
 */
const FORK = `${KEY_LOCKING}${WRITER_OK}if not writerOk(KEYS[1], ARGV[1], ARGV[2], ARGV[3]) then return "WRITER_LOST" end
if redis.call("EXISTS", KEYS[2]) == 0 then return "SOURCE_NOT_FOUND" end
if redis.call("EXISTS", KEYS[3]) == 1 or redis.call("EXISTS", KEYS[4]) == 1
  or redis.call("ZCARD", KEYS[5]) > 0 or redis.call("EXISTS", KEYS[7]) == 1 then
  return "NOT_EMPTY"
end
for i = 8, 11 do
  if redis.call("ZCARD", KEYS[i]) > 0 then return "NOT_EMPTY" end
end
redis.call("SET", KEYS[3], ARGV[4])
redis.call("SET", KEYS[4], ARGV[6])
redis.call("ZADD", KEYS[5], ARGV[7], ARGV[6])
redis.call("JSON.SET", KEYS[7], "$", ARGV[5])
if ARGV[8] ~= "0" then redis.call("EXPIRE", KEYS[7], ARGV[8]) end
for i = 9, #ARGV do redis.call("HINCRBY", KEYS[6], ARGV[i], 1) end
return "OK"`;

/** A checkpoint is JSON by contract; copying through JSON also detaches it from the caller's object. */
const copy = (checkpoint: SandboxCheckpoint): SandboxCheckpoint =>
  JSON.parse(JSON.stringify(checkpoint));

/** Thread heads and index members start with "~", so the client never JSON-parses a numeric id. */
const member = (id: string) => `~${id}`;

/**
 * `SandboxCheckpointStore` (from `@tanstack/ai-sandbox`) on Upstash Redis, with the optional
 * `forkFromCheckpoint` capability. A checkpoint is one immutable JSON document; each thread has a
 * head pointer and a sorted index, and blob keys are reference-counted in one hash so a sweeper can
 * delete unreferenced sandbox files. Every write is one Lua script that first checks the writer
 * lease (owner token + fence + expiry), so a writer that lost its lease cannot change anything.
 *
 * `forkFromCheckpoint` copies a checkpoint into an empty thread as its root and writes the
 * checkpoint's conversation as that thread's transcript in the same script; pass the `prefix` you
 * give `upstashPersistence()`. Checked against `runSandboxCheckpointStoreConformance` and
 * `runSandboxCheckpointForkConformance` from `@tanstack/ai-sandbox/testkit`.
 *
 * @example
 * ```ts
 * import { upstashPersistence } from "@upstash/agentkit-tanstack-ai/persistence";
 * import { upstashSandboxCheckpointStore } from "@upstash/agentkit-tanstack-ai/sandbox";
 *
 * const persistence = upstashPersistence();
 * const checkpoints = upstashSandboxCheckpointStore(); // same Redis + prefix as `persistence`
 * ```
 */
export function upstashSandboxCheckpointStore(
  config: UpstashSandboxCheckpointStoreConfig = {},
): ForkCapableSandboxCheckpointStore {
  const redis = config.redis ?? RedisClient.fromEnv();
  addTelemetry(redis, config.enableTelemetry);
  const p = config.prefix ?? "agentkit:tanstack";
  const now = config.now ?? (() => Date.now());
  const leaseDurationMs = config.leaseDurationMs ?? 120_000;
  const renewAfterMs = config.renewAfterMs ?? 45_000;
  if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new Error("leaseDurationMs must be finite and positive");
  }
  if (!Number.isFinite(renewAfterMs) || renewAfterMs <= 0 || renewAfterMs >= leaseDurationMs) {
    throw new Error("renewAfterMs must be finite, positive, and less than leaseDurationMs");
  }
  // The lease key outlives its lease by a day: expiry is decided by `expiresAt`, the PX only
  // garbage-collects leases nobody released.
  const px = String(Math.ceil(leaseDurationMs) + 86_400_000);
  const ttl = String(config.messagesTtlSeconds ?? 0);

  const enc = encodeURIComponent;
  const k = {
    doc: (id: string) => `${p}:sandbox:checkpoint:${enc(id)}`,
    head: (thread: string) => `${p}:sandbox:head:${enc(thread)}`,
    index: (thread: string) => `${p}:sandbox:checkpoints:${enc(thread)}`,
    writer: (thread: string) => `${p}:sandbox:writer:${enc(thread)}`,
    fence: (thread: string) => `${p}:sandbox:fence:${enc(thread)}`,
    refs: `${p}:sandbox:blobRefs`,
    // `upstashPersistence()` keys, which a fork must find empty (and fills the transcript of).
    transcript: (thread: string) => `${p}:thread:${thread}`,
    threadRuns: (thread: string) => `${p}:threadRuns:${thread}`,
    threadInterrupts: (thread: string) => `${p}:threadInterrupts:${thread}`,
    threadGenerationRuns: (thread: string) => `${p}:threadGenerationRuns:${thread}`,
    threadArtifacts: (thread: string) => `${p}:threadArtifacts:${thread}`,
  };

  const writerLost = (thread: string) =>
    new SandboxCheckpointWriterLostError(
      `Checkpoint writer lease for thread '${thread}' is no longer current`,
    );
  const writerArgs = (w: SandboxCheckpointWriter) => [w.ownerToken, String(w.fence), String(now())];

  const load = async (id: string): Promise<SandboxCheckpoint | null> =>
    (await redis.get<SandboxCheckpoint>(k.doc(id))) ?? null;

  return {
    async get(id) {
      assertValidIdentifier(id, "Checkpoint id");
      return load(id);
    },

    async list(threadId) {
      assertValidIdentifier(threadId, "Thread id");
      const members = await redis.zrange<string[]>(k.index(threadId), 0, -1);
      if (members.length === 0) return [];
      const docs = await redis.mget<(SandboxCheckpoint | null)[]>(
        ...members.map((m) => k.doc(String(m).slice(1))),
      );
      return docs
        .filter((d): d is SandboxCheckpoint => d !== null && d.threadId === threadId)
        .sort((a, b) => a.createdAt - b.createdAt || compareUtf8Bytes(a.id, b.id));
    },

    async getHead(threadId) {
      assertValidIdentifier(threadId, "Thread id");
      const head = await redis.get<string>(k.head(threadId));
      return head ? String(head).slice(1) : null;
    },

    async append({ checkpoint: input, expectedHeadId, writer }) {
      const checkpoint = copy(input);
      assertValidIdentifier(checkpoint.threadId, "Checkpoint thread id");
      assertValidIdentifier(writer.threadId, "Writer thread id");
      assertValidIdentifier(checkpoint.id, "Checkpoint id");
      if (expectedHeadId !== null) assertValidIdentifier(expectedHeadId, "Expected head id");
      if (checkpoint.parentCheckpointId != null) {
        assertValidIdentifier(checkpoint.parentCheckpointId, "Parent checkpoint id");
      }
      if (writer.threadId !== checkpoint.threadId) {
        throw new SandboxCheckpointWriterLostError(
          "Checkpoint writer thread does not match checkpoint thread",
        );
      }
      validateCheckpoint(checkpoint);
      const parentCheckpointId = checkpoint.parentCheckpointId ?? null;
      const stored: SandboxCheckpoint = { ...checkpoint, parentCheckpointId };
      const thread = stored.threadId;

      const result = (await redis.eval(
        APPEND,
        [k.writer(thread), k.doc(stored.id), k.head(thread), k.index(thread), k.refs],
        [
          ...writerArgs(writer),
          expectedHeadId === null ? "" : member(expectedHeadId),
          parentCheckpointId === expectedHeadId ? "1" : "0",
          JSON.stringify(stored),
          String(stored.createdAt),
          member(stored.id),
          ...blobKeysOf(stored),
        ],
      )) as string;
      if (result === "WRITER_LOST") throw writerLost(thread);
      if (result === "DUPLICATE") {
        throw new SandboxCheckpointDuplicateIdError(`Checkpoint '${stored.id}' already exists`);
      }
      if (result.startsWith("STALE_HEAD:")) {
        const actual = result.slice("STALE_HEAD:".length);
        throw new SandboxCheckpointConflictError(
          `Expected head '${expectedHeadId}', but thread '${thread}' is at '${actual ? actual.slice(1) : null}'`,
        );
      }
      if (result === "PARENT") {
        throw new SandboxCheckpointParentMismatchError(
          `Checkpoint '${stored.id}' parent does not match expected head`,
        );
      }
      return { headId: stored.id };
    },

    async deleteHead({ threadId, checkpointId, writer }) {
      assertValidIdentifier(threadId, "Thread id");
      assertValidIdentifier(checkpointId, "Checkpoint id");
      assertValidIdentifier(writer.threadId, "Writer thread id");
      if (writer.threadId !== threadId) {
        throw new SandboxCheckpointWriterLostError(
          "Checkpoint writer thread does not match operation thread",
        );
      }
      const result = (await redis.eval(
        DELETE_HEAD,
        [k.writer(threadId), k.head(threadId), k.doc(checkpointId), k.index(threadId), k.refs],
        [...writerArgs(writer), member(checkpointId)],
      )) as string;
      if (result === "WRITER_LOST") throw writerLost(threadId);
      if (result === "NOT_HEAD") {
        throw new SandboxCheckpointNotHeadError(
          `Checkpoint '${checkpointId}' is not the current head of thread '${threadId}'`,
        );
      }
      if (result === "MISSING") {
        throw new SandboxCheckpointNotHeadError(`Checkpoint '${checkpointId}' does not exist`);
      }
    },

    async acquireWriter(threadId): Promise<SandboxCheckpointWriterLease> {
      assertValidIdentifier(threadId, "Thread id");
      const ownerToken = globalThis.crypto.randomUUID();
      const lease = { expiresAt: now() + leaseDurationMs };
      const fence = (await redis.eval(
        ACQUIRE,
        [k.writer(threadId), k.fence(threadId)],
        [String(now()), ownerToken, String(lease.expiresAt), px],
      )) as number;
      if (fence === -1) {
        throw new SandboxCheckpointWriterConflictError(
          `Thread '${threadId}' already has an active checkpoint writer`,
        );
      }
      return {
        threadId,
        ownerToken,
        fence: Number(fence),
        get expiresAt() {
          return lease.expiresAt;
        },
        renewAfterMs,
        renew: async () => {
          const expiresAt = now() + leaseDurationMs;
          const ok = (await redis.eval(
            RENEW,
            [k.writer(threadId)],
            [ownerToken, String(fence), String(now()), String(expiresAt), px],
          )) as number;
          if (ok !== 1) throw writerLost(threadId);
          lease.expiresAt = expiresAt;
          return { expiresAt };
        },
        release: async () => {
          await redis.eval(RELEASE, [k.writer(threadId)], [ownerToken, String(fence)]);
        },
      };
    },

    async listBlobReferences() {
      const all = (await redis.hgetall<Record<string, number>>(k.refs)) ?? {};
      return Object.entries(all)
        .map(([key, references]) => ({ key, references: Number(references) }))
        .filter((r) => r.references > 0)
        .sort((a, b) => compareUtf8Bytes(a.key, b.key));
    },

    async forkFromCheckpoint(input) {
      const { sourceThreadId, sourceCheckpointId, destinationThreadId, destinationCheckpointId } =
        input;
      const writer = {
        threadId: input.writer.threadId,
        ownerToken: input.writer.ownerToken,
        fence: input.writer.fence,
      };
      assertValidIdentifier(sourceThreadId, "Source thread id");
      assertValidIdentifier(sourceCheckpointId, "Source checkpoint id");
      assertValidIdentifier(destinationThreadId, "Destination thread id");
      assertValidIdentifier(destinationCheckpointId, "Destination checkpoint id");
      assertValidIdentifier(writer.threadId, "Writer thread id");
      if (!Number.isFinite(input.createdAt)) {
        throw new SandboxCheckpointInvalidEntryError(
          "Fork checkpoint createdAt must be a finite number",
        );
      }
      if (sourceThreadId === destinationThreadId) {
        throw new SandboxCheckpointError(
          "SANDBOX_SNAPSHOT_FORK_SOURCE_THREAD_MISMATCH",
          "Source and destination threads must differ",
        );
      }
      const source = await load(sourceCheckpointId);
      if (!source) {
        throw new SandboxCheckpointError(
          "SANDBOX_SNAPSHOT_FORK_SOURCE_NOT_FOUND",
          "Source checkpoint was not found",
        );
      }
      if (source.threadId !== sourceThreadId) {
        throw new SandboxCheckpointError(
          "SANDBOX_SNAPSHOT_FORK_SOURCE_THREAD_MISMATCH",
          "Source checkpoint belongs to another thread",
        );
      }
      if (writer.threadId !== destinationThreadId) {
        throw new SandboxCheckpointWriterLostError(
          "Checkpoint writer thread does not match destination thread",
        );
      }
      const checkpoint: SandboxCheckpoint = {
        id: destinationCheckpointId,
        threadId: destinationThreadId,
        parentCheckpointId: null,
        createdAt: input.createdAt,
        reason: "fork-root",
        files: source.files,
        conversation: source.conversation,
        artifacts: source.artifacts,
      };
      validateCheckpoint(checkpoint);
      const d = destinationThreadId;
      const result = (await redis.eval(
        FORK,
        [
          k.writer(d),
          k.doc(sourceCheckpointId),
          k.doc(destinationCheckpointId),
          k.head(d),
          k.index(d),
          k.refs,
          k.transcript(d),
          k.threadRuns(d),
          k.threadInterrupts(d),
          k.threadGenerationRuns(d),
          k.threadArtifacts(d),
        ],
        [
          ...writerArgs(writer),
          JSON.stringify(checkpoint),
          JSON.stringify(checkpoint.conversation),
          member(destinationCheckpointId),
          String(checkpoint.createdAt),
          ttl,
          ...blobKeysOf(checkpoint),
        ],
      )) as string;
      if (result === "WRITER_LOST") throw writerLost(d);
      if (result === "SOURCE_NOT_FOUND") {
        throw new SandboxCheckpointError(
          "SANDBOX_SNAPSHOT_FORK_SOURCE_NOT_FOUND",
          "Source checkpoint was not found",
        );
      }
      if (result === "NOT_EMPTY") {
        throw new SandboxCheckpointError(
          "SANDBOX_SNAPSHOT_FORK_DESTINATION_NOT_EMPTY",
          "Destination thread is not empty",
        );
      }
      return { checkpoint: copy(checkpoint) };
    },
  };
}
