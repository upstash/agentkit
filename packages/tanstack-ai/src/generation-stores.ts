import type { Redis } from "@upstash/redis";
import type {
  ArtifactRecord,
  ArtifactStore,
  GenerationRunRecord,
  GenerationRunStore,
} from "@tanstack/ai-persistence";
import {
  CREATE,
  KEY_LOCKING,
  PATCH,
  assertId,
  checkRun,
  loadDocs,
  toMergePatches,
} from "./records.js";

/**
 * Replace an artifact document and move it between indexes if its run or thread changed. Which
 * indexes it is in is kept in a small side hash of raw index-key strings (KEYS[2]) so the document
 * stays exactly the record. Under `allow-key-locking` the old index keys must be declared, so the
 * caller reads them first and the script compare-and-swaps, returning 0 (retry) if a concurrent save
 * moved the artifact in between.
 * KEYS: document, side hash, new run index, new thread index, [old run index, old thread index].
 * ARGV: expected old run index ("" = none), expected old thread index, document JSON, createdAt, id.
 */
const SAVE_ARTIFACT = `${KEY_LOCKING}local curRun = redis.call("HGET", KEYS[2], "run") or ""
local curThread = redis.call("HGET", KEYS[2], "thread") or ""
if curRun ~= ARGV[1] or curThread ~= ARGV[2] then return 0 end
if KEYS[5] and KEYS[5] ~= KEYS[3] then redis.call("ZREM", KEYS[5], ARGV[5]) end
if KEYS[6] and KEYS[6] ~= KEYS[4] then redis.call("ZREM", KEYS[6], ARGV[5]) end
redis.call("JSON.SET", KEYS[1], "$", ARGV[3])
redis.call("HSET", KEYS[2], "run", KEYS[3], "thread", KEYS[4])
redis.call("ZADD", KEYS[3], ARGV[4], ARGV[5])
redis.call("ZADD", KEYS[4], ARGV[4], ARGV[5])
return 1`;

/**
 * `GenerationRunStore`: one record per one-shot generation job (image, video, speech,
 * transcription), written by `withGenerationPersistence`. A JSON document per run and a per-thread
 * sorted set by `startedAt`, so `findLatestForThread` is one index read.
 */
export function redisGenerationRunStore(redis: Redis, prefix: string): GenerationRunStore {
  const run = (id: string) => `${prefix}:generationRun:${id}`;
  const thread = (id: string) => `${prefix}:threadGenerationRuns:${id}`;
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
        CREATE,
        [run(input.runId), thread(input.threadId)],
        [JSON.stringify(record), String(input.startedAt), input.runId],
      );
      return checkRun(stored as GenerationRunRecord)!;
    },

    async update(runId, fields) {
      assertId(runId, "runId");
      await redis.eval(PATCH, [run(runId)], toMergePatches(fields));
    },

    async get(runId) {
      assertId(runId, "runId");
      return checkRun(await redis.json.get<GenerationRunRecord>(run(runId)));
    },

    async findLatestForThread(threadId) {
      assertId(threadId, "threadId");
      const [id] = await redis.zrange<string[]>(thread(threadId), 0, 0, { rev: true });
      return id === undefined ? null : checkRun(await redis.json.get<GenerationRunRecord>(run(id)));
    },
  };
}

/**
 * `ArtifactStore`: metadata rows for generated outputs (name, MIME type, size, the `blobKey` of the
 * bytes). Indexed by run and by thread, sorted by `createdAt` then id (sorted-set ties sort by bytes,
 * matching the reference store). The bytes themselves live in the blob store.
 */
export function redisArtifactStore(redis: Redis, prefix: string): ArtifactStore {
  const k = {
    artifact: (id: string) => `${prefix}:artifact:${id}`,
    where: (id: string) => `${prefix}:artifactIndexes:${id}`,
    run: (id: string) => `${prefix}:runArtifacts:${id}`,
    thread: (id: string) => `${prefix}:threadArtifacts:${id}`,
  };
  const load = async (ids: string[]) => loadDocs<ArtifactRecord>(redis, ids.map(k.artifact));

  async function remove(record: ArtifactRecord): Promise<void> {
    const tx = redis.multi();
    tx.del(k.artifact(record.artifactId), k.where(record.artifactId));
    tx.zrem(k.run(record.runId), record.artifactId);
    tx.zrem(k.thread(record.threadId), record.artifactId);
    await tx.exec();
  }

  const store: ArtifactStore = {
    async save(record) {
      assertId(record.artifactId, "artifactId");
      assertId(record.runId, "runId");
      assertId(record.threadId, "threadId");
      const id = record.artifactId;
      for (let attempt = 0; attempt < 5; attempt++) {
        const where = await redis.hmget<Record<string, string | null>>(
          k.where(id),
          "run",
          "thread",
        );
        const oldRun = where?.run ?? null;
        const oldThread = where?.thread ?? null;
        const saved = await redis.eval(
          SAVE_ARTIFACT,
          [
            k.artifact(id),
            k.where(id),
            k.run(record.runId),
            k.thread(record.threadId),
            ...(oldRun && oldThread ? [oldRun, oldThread] : []),
          ],
          [oldRun ?? "", oldThread ?? "", JSON.stringify(record), String(record.createdAt), id],
        );
        if (Number(saved) === 1) return;
      }
      throw new Error(
        `@upstash/agentkit-tanstack-ai: artifact ${JSON.stringify(id)} kept changing during save.`,
      );
    },

    async get(artifactId) {
      assertId(artifactId, "artifactId");
      return (await redis.json.get<ArtifactRecord>(k.artifact(artifactId))) ?? null;
    },

    async list(runId) {
      assertId(runId, "runId");
      return load(await redis.zrange<string[]>(k.run(runId), 0, -1));
    },

    async listForThread(threadId) {
      assertId(threadId, "threadId");
      return load(await redis.zrange<string[]>(k.thread(threadId), 0, -1));
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
