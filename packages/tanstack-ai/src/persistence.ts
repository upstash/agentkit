import type { Redis } from "@upstash/redis";
import { Redis as RedisClient } from "@upstash/redis";
import type { ModelMessage, RunRecord, RunStatus, RunStore } from "@tanstack/ai";
import type {
  ChatPersistence,
  InterruptCommitEntry,
  InterruptRecord,
  InterruptStore,
  MessageStore,
  MetadataStore,
} from "@tanstack/ai-persistence";
import { addTelemetry } from "./telemetry.js";
import { assertId, decode, decodeFields, encode, encodeFields } from "./codec.js";

export interface UpstashPersistenceConfig {
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /** Base key prefix. Defaults to `agentkit:tanstack`. */
  prefix?: string;
  /**
   * Expire a thread's stored transcript this many seconds after its last save. Omit to keep
   * transcripts forever. Run, interrupt and metadata records are never expired automatically.
   */
  messagesTtlSeconds?: number;
  /**
   * Report the sdk name + version to Upstash as a header on the requests made by your redis client.
   * Can also be disabled with the `UPSTASH_DISABLE_TELEMETRY` env var. Defaults to `true`.
   */
  enableTelemetry?: boolean;
}

const RUN_STATUSES: Record<RunStatus, true> = {
  running: true,
  interrupted: true,
  completed: true,
  failed: true,
  aborted: true,
};

/**
 * Create a run hash only if it does not exist yet, index it, and return the stored hash either way
 * (the idempotent `createOrResume` contract: an existing record comes back unchanged).
 * KEYS: run hash, thread index, parent index (may be unused). ARGV: startedAt, runId, hasParent, pairs…
 */
const CREATE_RUN = `if redis.call("EXISTS", KEYS[1]) == 0 then
  local fields = {}
  for i = 4, #ARGV do fields[#fields + 1] = ARGV[i] end
  redis.call("HSET", KEYS[1], unpack(fields))
  redis.call("ZADD", KEYS[2], ARGV[1], ARGV[2])
  if ARGV[3] == "1" then redis.call("ZADD", KEYS[3], ARGV[1], ARGV[2]) end
end
return redis.call("HGETALL", KEYS[1])`;

/**
 * Patch an existing hash: set N field/value pairs, delete the remaining named fields. A missing hash
 * is a no-op (the "unknown runId never creates a record" invariant). ARGV: N, pairs…, deletes…
 */
const PATCH = `if redis.call("EXISTS", KEYS[1]) == 0 then return 0 end
local n = tonumber(ARGV[1])
if n > 0 then
  local fields = {}
  for i = 2, 1 + n * 2 do fields[#fields + 1] = ARGV[i] end
  redis.call("HSET", KEYS[1], unpack(fields))
end
for i = 2 + n * 2, #ARGV do redis.call("HDEL", KEYS[1], ARGV[i]) end
return 1`;

/** Create an interrupt hash if absent and index it by thread and by run. ARGV: requestedAt, id, pairs… */
const CREATE_INTERRUPT = `if redis.call("EXISTS", KEYS[1]) == 0 then
  local fields = {}
  for i = 3, #ARGV do fields[#fields + 1] = ARGV[i] end
  redis.call("HSET", KEYS[1], unpack(fields))
  redis.call("ZADD", KEYS[2], ARGV[1], ARGV[2])
  redis.call("ZADD", KEYS[3], ARGV[1], ARGV[2])
end
return 0`;

/**
 * Settle a batch of interrupts atomically: every key must exist and be pending, or nothing changes.
 * ARGV: pendingValue, resolvedAtValue, then per key: statusValue, hasResponse, responseValue.
 */
const COMMIT_BATCH = `for i = 1, #KEYS do
  local status = redis.call("HGET", KEYS[i], "status")
  if not status then return redis.error_reply("missing:" .. i) end
  if status ~= ARGV[1] then return redis.error_reply("nonpending:" .. i) end
end
for i = 1, #KEYS do
  local base = 3 + (i - 1) * 3
  redis.call("HSET", KEYS[i], "status", ARGV[base], "resolvedAt", ARGV[2])
  if ARGV[base + 1] == "1" then
    redis.call("HSET", KEYS[i], "response", ARGV[base + 2])
  else
    redis.call("HDEL", KEYS[i], "response")
  end
end
return #KEYS`;

/** `HGETALL` inside Lua returns a flat `[field, value, …]` array; turn it into an object. */
function pairsToObject(flat: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(flat)) return out;
  for (let i = 0; i + 1 < flat.length; i += 2) out[String(flat[i])] = flat[i + 1];
  return out;
}

/** Validate a stored run at deserialization — downstream readers act destructively on `status`. */
function toRunRecord(raw: Record<string, unknown> | null | undefined): RunRecord | null {
  const record = decodeFields<RunRecord>(raw);
  if (!record) return null;
  if (typeof record.status !== "string" || !Object.hasOwn(RUN_STATUSES, record.status)) {
    throw new Error(
      `@upstash/agentkit-tanstack-ai: run ${JSON.stringify(record.runId)} has an invalid status.`,
    );
  }
  return record;
}

function flattenPairs(record: Record<string, string>): string[] {
  return Object.entries(record).flat();
}

/**
 * Every TanStack AI chat-state store on Upstash Redis — pass the result to `withPersistence()`.
 *
 * - **messages**: the thread transcript, one value per thread (`saveThread` is a full overwrite).
 * - **runs**: one hash per run plus sorted-set indexes by thread, by parent run and by detach time,
 *   so `findActiveRun` (reconnect), `listByThread`, `listByParentRun` (subagent cards) and
 *   `listReclaimable` (the sandbox reaper) are all index reads, not scans.
 * - **interrupts**: human-in-the-loop pauses, indexed by thread and run; `commitBatch` settles a batch
 *   atomically in one Lua script.
 * - **metadata**: a hash per namespace, so `(namespace, key)` never collides.
 *
 * Mutations are single commands or single `EVAL`s, so the stores are safe across instances over the
 * REST API. Checked against TanStack's own `runPersistenceConformance` suite.
 *
 * ```ts
 * import { chat } from "@tanstack/ai";
 * import { withPersistence } from "@tanstack/ai-persistence";
 * import { upstashPersistence } from "@upstash/agentkit-tanstack-ai";
 *
 * const persistence = upstashPersistence();
 * chat({ adapter, messages, threadId, middleware: [withPersistence(persistence)] });
 * ```
 */
export function upstashPersistence(config: UpstashPersistenceConfig = {}): ChatPersistence {
  const redis = config.redis ?? RedisClient.fromEnv();
  addTelemetry(redis, config.enableTelemetry);
  const p = config.prefix ?? "agentkit:tanstack";
  const k = {
    thread: (id: string) => `${p}:thread:${id}`,
    run: (id: string) => `${p}:run:${id}`,
    threadRuns: (id: string) => `${p}:threadRuns:${id}`,
    parentRuns: (id: string) => `${p}:parentRuns:${id}`,
    detached: () => `${p}:detachedRuns`,
    interrupt: (id: string) => `${p}:interrupt:${id}`,
    threadInterrupts: (id: string) => `${p}:threadInterrupts:${id}`,
    runInterrupts: (id: string) => `${p}:runInterrupts:${id}`,
    meta: (ns: string) => `${p}:meta:${ns}`,
  };

  /** Fetch run hashes by id, in the given order, dropping ids whose hash is gone. */
  async function loadRuns(ids: string[]): Promise<RunRecord[]> {
    if (ids.length === 0) return [];
    const pipe = redis.pipeline();
    for (const id of ids) pipe.hgetall(k.run(id));
    const rows = (await pipe.exec()) as (Record<string, unknown> | null)[];
    return rows.map(toRunRecord).filter((r): r is RunRecord => r !== null);
  }

  async function loadInterrupts(ids: string[]): Promise<InterruptRecord[]> {
    if (ids.length === 0) return [];
    const pipe = redis.pipeline();
    for (const id of ids) pipe.hgetall(k.interrupt(id));
    const rows = (await pipe.exec()) as (Record<string, unknown> | null)[];
    return rows
      .map((row) => decodeFields<InterruptRecord>(row))
      .filter((r): r is InterruptRecord => r !== null);
  }

  const messages: MessageStore = {
    loadThread: (async (threadId: string) => {
      assertId(threadId, "threadId");
      const raw = await redis.get(k.thread(threadId));
      return raw == null ? [] : decode<ModelMessage[]>(raw);
    }) as MessageStore["loadThread"],
    async saveThread(threadId, list) {
      assertId(threadId, "threadId");
      const opts = config.messagesTtlSeconds ? { ex: config.messagesTtlSeconds } : undefined;
      await (opts
        ? redis.set(k.thread(threadId), encode(list), opts)
        : redis.set(k.thread(threadId), encode(list)));
    },
  };

  const runs: RunStore = {
    async createOrResume(input) {
      assertId(input.runId, "runId");
      assertId(input.threadId, "threadId");
      const record: RunRecord = {
        runId: input.runId,
        threadId: input.threadId,
        status: input.status ?? "running",
        startedAt: input.startedAt,
        ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
        ...(input.subagentRunId !== undefined ? { subagentRunId: input.subagentRunId } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
      };
      const hasParent = input.parentRunId !== undefined;
      const stored = await redis.eval(
        CREATE_RUN,
        [
          k.run(input.runId),
          k.threadRuns(input.threadId),
          k.parentRuns(hasParent ? input.parentRunId! : "_"),
        ],
        [
          String(input.startedAt),
          input.runId,
          hasParent ? "1" : "0",
          ...flattenPairs(encodeFields(record as unknown as Record<string, unknown>)),
        ],
      );
      return toRunRecord(pairsToObject(stored))!;
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
      const updated = await redis.eval(
        PATCH,
        [k.run(runId)],
        [String(encoded.length / 2), ...encoded, ...del],
      );
      if (Number(updated) !== 1) return;
      // Keep the reclaim index in step. It is only a candidate list — `listReclaimable` re-checks
      // every record — so a racing update can at worst leave a stale member, never a wrong answer.
      if ("detachedSince" in patch || "status" in patch) {
        const current = toRunRecord(await redis.hgetall(k.run(runId)));
        if (current && current.status === "running" && current.detachedSince !== undefined) {
          await redis.zadd(k.detached(), { score: current.detachedSince, member: runId });
        } else {
          await redis.zrem(k.detached(), runId);
        }
      }
    },

    async get(runId) {
      assertId(runId, "runId");
      return toRunRecord(await redis.hgetall(k.run(runId)));
    },

    async findActiveRun(threadId) {
      assertId(threadId, "threadId");
      // Newest first; stop at the first running one.
      const PAGE = 50;
      for (let start = 0; ; start += PAGE) {
        const ids = (await redis.zrange(k.threadRuns(threadId), start, start + PAGE - 1, {
          rev: true,
        })) as string[];
        const records = await loadRuns(ids);
        const active = records.find((r) => r.status === "running");
        if (active) return active;
        if (ids.length < PAGE) return null;
      }
    },

    async listByThread(threadId) {
      assertId(threadId, "threadId");
      const ids = (await redis.zrange(k.threadRuns(threadId), 0, -1)) as string[];
      return loadRuns(ids);
    },

    async listByParentRun(parentRunId) {
      assertId(parentRunId, "parentRunId");
      const ids = (await redis.zrange(k.parentRuns(parentRunId), 0, -1)) as string[];
      return loadRuns(ids);
    },

    async listReclaimable({ now, ttlMs }) {
      const cutoff = now - ttlMs;
      const ids = (await redis.zrange(k.detached(), "-inf", cutoff, { byScore: true })) as string[];
      const records = await loadRuns(ids);
      return records.filter(
        (r) => r.status === "running" && r.detachedSince !== undefined && r.detachedSince <= cutoff,
      );
    },
  };

  const PENDING = encode("pending");

  const interrupts: InterruptStore = {
    async create(record) {
      assertId(record.interruptId, "interruptId");
      const full: InterruptRecord = { ...record, status: "pending" };
      await redis.eval(
        CREATE_INTERRUPT,
        [
          k.interrupt(record.interruptId),
          k.threadInterrupts(record.threadId),
          k.runInterrupts(record.runId),
        ],
        [
          String(record.requestedAt),
          record.interruptId,
          ...flattenPairs(encodeFields(full as unknown as Record<string, unknown>)),
        ],
      );
    },

    async resolve(interruptId, response) {
      assertId(interruptId, "interruptId");
      const set = encodeFields({ status: "resolved", resolvedAt: Date.now() });
      // `response` is set even when undefined, so a resolved record always carries the field.
      set.response = encode(response);
      const pairs = flattenPairs(set);
      await redis.eval(PATCH, [k.interrupt(interruptId)], [String(pairs.length / 2), ...pairs]);
    },

    async cancel(interruptId) {
      assertId(interruptId, "interruptId");
      const pairs = flattenPairs(encodeFields({ status: "cancelled", resolvedAt: Date.now() }));
      await redis.eval(PATCH, [k.interrupt(interruptId)], [String(pairs.length / 2), ...pairs]);
    },

    async commitBatch(entries: ReadonlyArray<InterruptCommitEntry>) {
      if (entries.length === 0) return;
      const seen = new Set<string>();
      for (const entry of entries) {
        assertId(entry.interruptId, "interruptId");
        if (seen.has(entry.interruptId)) {
          throw new Error(`Interrupt batch contains duplicate id: ${entry.interruptId}.`);
        }
        seen.add(entry.interruptId);
      }
      const args: string[] = [PENDING, encode(Date.now())];
      for (const entry of entries) {
        const hasResponse = entry.status === "resolved";
        args.push(
          encode(entry.status),
          hasResponse ? "1" : "0",
          hasResponse ? encode(entry.response) : "",
        );
      }
      try {
        await redis.eval(
          COMMIT_BATCH,
          entries.map((e) => k.interrupt(e.interruptId)),
          args,
        );
      } catch (error) {
        const match = /(missing|nonpending):(\d+)/.exec(String((error as Error)?.message ?? error));
        if (!match) throw error;
        const id = entries[Number(match[2]) - 1]?.interruptId;
        throw new Error(
          match[1] === "missing"
            ? `Interrupt batch references missing id: ${id}.`
            : `Interrupt batch references non-pending id: ${id}.`,
        );
      }
    },

    async get(interruptId) {
      assertId(interruptId, "interruptId");
      return decodeFields<InterruptRecord>(await redis.hgetall(k.interrupt(interruptId)));
    },

    async list(threadId) {
      assertId(threadId, "threadId");
      return loadInterrupts((await redis.zrange(k.threadInterrupts(threadId), 0, -1)) as string[]);
    },

    async listPending(threadId) {
      return (await interrupts.list(threadId)).filter((r) => r.status === "pending");
    },

    async listByRun(runId) {
      assertId(runId, "runId");
      return loadInterrupts((await redis.zrange(k.runInterrupts(runId), 0, -1)) as string[]);
    },

    async listPendingByRun(runId) {
      return (await interrupts.listByRun(runId)).filter((r) => r.status === "pending");
    },
  };

  const metadata: MetadataStore = {
    async get(namespace, key) {
      const raw = await redis.hget(k.meta(namespace), key);
      return raw == null ? null : decode<unknown>(raw);
    },
    async set(namespace, key, value) {
      await redis.hset(k.meta(namespace), { [key]: encode(value) });
    },
    async delete(namespace, key) {
      await redis.hdel(k.meta(namespace), key);
    },
  };

  return { stores: { messages, runs, interrupts, metadata } };
}
