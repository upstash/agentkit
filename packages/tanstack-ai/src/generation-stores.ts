import type { Redis } from "@upstash/redis";
import type { RunStatus } from "@tanstack/ai";
import type {
  ArtifactRecord,
  ArtifactStore,
  GenerationRunRecord,
  GenerationRunStore,
} from "@tanstack/ai-persistence";
import { assertId, decodeFields, encodeFields } from "./codec.js";

const RUN_STATUSES: Record<RunStatus, true> = {
  running: true,
  interrupted: true,
  completed: true,
  failed: true,
  aborted: true,
};

/** Create a hash if absent, index it in one sorted set, return the stored hash. ARGV: score, member, pairs… */
const CREATE_INDEXED = `#!lua flags=allow-key-locking
if redis.call("EXISTS", KEYS[1]) == 0 then
  local fields = {}
  for i = 3, #ARGV do fields[#fields + 1] = ARGV[i] end
  redis.call("HSET", KEYS[1], unpack(fields))
  redis.call("ZADD", KEYS[2], ARGV[1], ARGV[2])
end
return redis.call("HGETALL", KEYS[1])`;

/** Patch an existing hash (N pairs to set, then fields to delete); a missing hash is a no-op. */
const PATCH = `#!lua flags=allow-key-locking
if redis.call("EXISTS", KEYS[1]) == 0 then return 0 end
local n = tonumber(ARGV[1])
if n > 0 then
  local fields = {}
  for i = 2, 1 + n * 2 do fields[#fields + 1] = ARGV[i] end
  redis.call("HSET", KEYS[1], unpack(fields))
end
for i = 2 + n * 2, #ARGV do redis.call("HDEL", KEYS[1], ARGV[i]) end
return 1`;

/**
 * Replace an artifact record and move it between indexes if its run or thread changed. The hash
 * remembers the two index keys it is in (`__runIndex` / `__threadIndex`, raw strings the codec
 * skips). Under `allow-key-locking` every touched key must be declared, so the caller reads those two
 * first and passes them as KEYS[4..5]; the script is a compare-and-swap that returns 0 (caller
 * retries) if a concurrent save moved the artifact in between.
 * KEYS: hash, new run index, new thread index, [old run index, old thread index].
 * ARGV: expected old run index ("" = none), expected old thread index, createdAt, id, pairs…
 */
const SAVE_ARTIFACT = `#!lua flags=allow-key-locking
local curRun = redis.call("HGET", KEYS[1], "__runIndex") or ""
local curThread = redis.call("HGET", KEYS[1], "__threadIndex") or ""
if curRun ~= ARGV[1] or curThread ~= ARGV[2] then return 0 end
if KEYS[4] and KEYS[4] ~= KEYS[2] then redis.call("ZREM", KEYS[4], ARGV[4]) end
if KEYS[5] and KEYS[5] ~= KEYS[3] then redis.call("ZREM", KEYS[5], ARGV[4]) end
redis.call("DEL", KEYS[1])
local fields = {"__runIndex", KEYS[2], "__threadIndex", KEYS[3]}
for i = 5, #ARGV do fields[#fields + 1] = ARGV[i] end
redis.call("HSET", KEYS[1], unpack(fields))
redis.call("ZADD", KEYS[2], ARGV[3], ARGV[4])
redis.call("ZADD", KEYS[3], ARGV[3], ARGV[4])
return 1`;

function pairsToObject(flat: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(flat)) return out;
  for (let i = 0; i + 1 < flat.length; i += 2) out[String(flat[i])] = flat[i + 1];
  return out;
}

const flattenPairs = (record: Record<string, string>) => Object.entries(record).flat();

function toGenerationRun(
  raw: Record<string, unknown> | null | undefined,
): GenerationRunRecord | null {
  const record = decodeFields<GenerationRunRecord>(raw);
  if (!record) return null;
  if (typeof record.status !== "string" || !Object.hasOwn(RUN_STATUSES, record.status)) {
    throw new Error(
      `@upstash/agentkit-tanstack-ai: generation run ${JSON.stringify(record.runId)} has an invalid status.`,
    );
  }
  return record;
}

/**
 * `GenerationRunStore`: one record per one-shot generation job (image, video, speech,
 * transcription), written by `withGenerationPersistence`. A hash per run and a per-thread sorted
 * set by `startedAt`, so `findLatestForThread` is one index read.
 */
export function redisGenerationRunStore(redis: Redis, prefix: string): GenerationRunStore {
  const k = {
    run: (id: string) => `${prefix}:generationRun:${id}`,
    thread: (id: string) => `${prefix}:threadGenerationRuns:${id}`,
  };
  return {
    async createOrResume(input) {
      assertId(input.runId, "runId");
      assertId(input.threadId, "threadId");
      const record: GenerationRunRecord = {
        runId: input.runId,
        threadId: input.threadId,
        activity: input.activity,
        provider: input.provider,
        model: input.model,
        status: input.status ?? "running",
        startedAt: input.startedAt,
      };
      const stored = await redis.eval(
        CREATE_INDEXED,
        [k.run(input.runId), k.thread(input.threadId)],
        [
          String(input.startedAt),
          input.runId,
          ...flattenPairs(encodeFields(record as unknown as Record<string, unknown>)),
        ],
      );
      return toGenerationRun(pairsToObject(stored))!;
    },

    async update(runId, patch) {
      assertId(runId, "runId");
      const set: Record<string, unknown> = {};
      const del: string[] = [];
      for (const [field, value] of Object.entries(patch)) {
        if (value === undefined) del.push(field);
        else set[field] = value;
      }
      const encoded = flattenPairs(encodeFields(set));
      await redis.eval(PATCH, [k.run(runId)], [String(encoded.length / 2), ...encoded, ...del]);
    },

    async get(runId) {
      assertId(runId, "runId");
      return toGenerationRun(await redis.hgetall(k.run(runId)));
    },

    async findLatestForThread(threadId) {
      assertId(threadId, "threadId");
      const [id] = (await redis.zrange(k.thread(threadId), 0, 0, { rev: true })) as string[];
      return id === undefined ? null : toGenerationRun(await redis.hgetall(k.run(id)));
    },
  };
}

/**
 * `ArtifactStore`: metadata rows for generated outputs (name, MIME type, size, the `blobKey` of the
 * bytes). Indexed by run and by thread, sorted by `createdAt` then id (byte order), matching the
 * reference store. The bytes themselves live in the blob store.
 */
export function redisArtifactStore(redis: Redis, prefix: string): ArtifactStore {
  const k = {
    artifact: (id: string) => `${prefix}:artifact:${id}`,
    run: (id: string) => `${prefix}:runArtifacts:${id}`,
    thread: (id: string) => `${prefix}:threadArtifacts:${id}`,
  };

  async function load(ids: string[]): Promise<ArtifactRecord[]> {
    if (ids.length === 0) return [];
    const pipe = redis.pipeline();
    for (const id of ids) pipe.hgetall(k.artifact(id));
    const rows = (await pipe.exec()) as (Record<string, unknown> | null)[];
    return rows
      .map((row) => decodeFields<ArtifactRecord>(row))
      .filter((r): r is ArtifactRecord => r !== null);
  }

  async function remove(record: ArtifactRecord): Promise<void> {
    const tx = redis.multi();
    tx.del(k.artifact(record.artifactId));
    tx.zrem(k.run(record.runId), record.artifactId);
    tx.zrem(k.thread(record.threadId), record.artifactId);
    await tx.exec();
  }

  const store: ArtifactStore = {
    async save(record) {
      assertId(record.artifactId, "artifactId");
      assertId(record.runId, "runId");
      assertId(record.threadId, "threadId");
      const fields = flattenPairs(encodeFields(record as unknown as Record<string, unknown>));
      const hash = k.artifact(record.artifactId);
      for (let attempt = 0; attempt < 5; attempt++) {
        const stored = await redis.hmget<Record<string, string | null>>(
          hash,
          "__runIndex",
          "__threadIndex",
        );
        const oldRun = stored?.__runIndex ?? null;
        const oldThread = stored?.__threadIndex ?? null;
        const old = oldRun && oldThread ? [oldRun, oldThread] : [];
        const saved = await redis.eval(
          SAVE_ARTIFACT,
          [hash, k.run(record.runId), k.thread(record.threadId), ...old],
          [oldRun ?? "", oldThread ?? "", String(record.createdAt), record.artifactId, ...fields],
        );
        if (Number(saved) === 1) return;
      }
      throw new Error(
        `@upstash/agentkit-tanstack-ai: artifact ${JSON.stringify(record.artifactId)} kept changing during save.`,
      );
    },

    async get(artifactId) {
      assertId(artifactId, "artifactId");
      return decodeFields<ArtifactRecord>(await redis.hgetall(k.artifact(artifactId)));
    },

    async list(runId) {
      assertId(runId, "runId");
      return load((await redis.zrange(k.run(runId), 0, -1)) as string[]);
    },

    async listForThread(threadId) {
      assertId(threadId, "threadId");
      return load((await redis.zrange(k.thread(threadId), 0, -1)) as string[]);
    },

    async delete(artifactId) {
      const record = await store.get(artifactId);
      if (record) await remove(record);
    },

    async deleteForRun(runId) {
      for (const record of await store.list(runId)) await remove(record);
    },
  };
  return store;
}
