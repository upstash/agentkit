import type { Redis } from "@upstash/redis";
import { LogConflictError, LogTruncatedError, OwnershipLostError } from "@tanstack/ai-persistence";
import type {
  LogEntry,
  LogRecord,
  LogSnapshot,
  LogStore,
  OfferResult,
  OfferedInput,
  OrphanedLog,
} from "@tanstack/ai-persistence";
import { KEY_LOCKING, assertId } from "./records.js";

// How the log lives in Redis. Per log (`<prefix>:log:<logId>:`):
//   meta    hash   head, first, epoch, owner, harness, exp, rel, wake, aff, del, laneH, oseq
//   recs    zset   score = seq, member = "<seq>:<record JSON>"
//   snap    string {"seq":N,"version":..,"state":..}
//   offers  hash   inputId -> record JSON (kept after consumption, for duplicate detection)
//   info    hash   inputId -> offeredAt
//   pend    zset   pending offers, score = offer order
//   tick    string INCR on append / offer / delete: the change signal `subscribe` polls
// Shared (`<prefix>:`): `logDue` zset (logId -> when it needs an owner), `logHosts` hash (host heartbeats).
// The store clock is the Redis server clock (`TIME` inside each script), so hosts need no clock sync.
// Every script declares the same nine keys, runs atomically, and uses `%.0f` for numbers it writes
// (Lua would print epoch milliseconds in scientific notation).

const PRELUDE = `${KEY_LOCKING}local M, RECS, SNAP, OFFERS, INFO, PEND, TICK, DUE, HOSTS =
  KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6], KEYS[7], KEYS[8], KEYS[9]
local LOGM = ARGV[1]
local function fmt(n) return string.format("%.0f", n) end
local function now()
  local t = redis.call("TIME")
  return tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
local function geti(f, d)
  local v = redis.call("HGET", M, f)
  if v then return tonumber(v) end
  return d
end
local function canWrite(epoch)
  if redis.call("HGET", M, "del") == "1" then return false end
  local ep = geti("epoch", 0)
  if ep == 0 then return epoch == 0 end
  return epoch == ep and redis.call("HGET", M, "rel") ~= "1"
end
local function owned(epoch) return epoch ~= 0 and canWrite(epoch) end
local function refresh()
  local ep = geti("epoch", 0)
  local due = nil
  if ep > 0 and redis.call("HGET", M, "rel") ~= "1" then
    due = geti("exp", 0)
  else
    local first = redis.call("ZRANGE", PEND, 0, 0)
    if first[1] then
      due = tonumber(redis.call("HGET", INFO, first[1]))
    elseif ep > 0 and redis.call("HEXISTS", M, "wake") == 1 then
      due = geti("wake", 0)
    end
  end
  if due then redis.call("ZADD", DUE, fmt(due), LOGM) else redis.call("ZREM", DUE, LOGM) end
end
`;

/** ARGV: member, epoch, seq, badJson, nRecords, nConsumes, records..., consumes... */
const APPEND = `${PRELUDE}local epoch, seq = tonumber(ARGV[2]), tonumber(ARGV[3])
local nrec, ncon = tonumber(ARGV[5]), tonumber(ARGV[6])
if not canWrite(epoch) then return {"OWN"} end
if seq ~= geti("head", 0) + 1 then return {"CONFLICT"} end
for i = 1, ncon do
  local id = ARGV[6 + nrec + i]
  if not redis.call("ZSCORE", PEND, id) then return {"TYPE", id} end
end
if ARGV[4] == "1" then return {"JSON"} end
for i = 1, nrec do
  local s = seq + i - 1
  redis.call("ZADD", RECS, fmt(s), fmt(s) .. ":" .. ARGV[6 + i])
end
if nrec > 0 then redis.call("HSET", M, "head", fmt(seq + nrec - 1)) end
for i = 1, ncon do redis.call("ZREM", PEND, ARGV[6 + nrec + i]) end
local tick = redis.call("INCR", TICK)
refresh()
return {"OK", tick}`;

/** ARGV: member, after, limit (-1 = all). */
const READ = `${PRELUDE}local after, limit = tonumber(ARGV[2]), tonumber(ARGV[3])
local first = geti("first", 1)
if after < first - 1 then return {"TRUNC", fmt(first)} end
if limit == 0 then return {"OK"} end
local rows
if limit < 0 then
  rows = redis.call("ZRANGEBYSCORE", RECS, "(" .. fmt(after), "+inf")
else
  rows = redis.call("ZRANGEBYSCORE", RECS, "(" .. fmt(after), "+inf", "LIMIT", 0, limit)
end
local out = {"OK"}
for i = 1, #rows do out[i + 1] = rows[i] end
return out`;

/** ARGV: member, harness, ownerId, ttlMs, affinity, hasAffinity. */
const ACQUIRE = `${PRELUDE}local harness, ownerId, ttl, aff = ARGV[2], ARGV[3], tonumber(ARGV[4]), ARGV[5]
local hasAff = ARGV[6] == "1"
local n = now()
local ep = geti("epoch", 0)
local owner = redis.call("HGET", M, "owner")
local rel = redis.call("HGET", M, "rel")
local live = ep > 0 and rel ~= "1" and geti("exp", 0) > n
if live and owner ~= ownerId then return {"NULL"} end
local pin = redis.call("HGET", M, "aff")
if pin and not (hasAff and pin == aff) then
  local host = redis.call("HGET", HOSTS, pin)
  if host and tonumber(host) > n then return {"NULL"} end
end
if live then
  redis.call("HSET", M, "exp", fmt(n + ttl))
  refresh()
  return {"OK", fmt(ep), "0"}
end
local expired = ep > 0 and rel ~= "1" and owner ~= ownerId
local newep = ep + 1
redis.call("HSET", M, "harness", harness, "owner", ownerId, "epoch", fmt(newep), "exp", fmt(n + ttl), "rel", "0")
redis.call("HDEL", M, "wake", "del")
refresh()
return {"OK", fmt(newep), expired and "1" or "0"}`;

/** ARGV: member, ownerId, epoch, ttlMs. */
const RENEW = `${PRELUDE}local epoch = tonumber(ARGV[3])
if redis.call("HGET", M, "owner") ~= ARGV[2] or geti("epoch", 0) ~= epoch or redis.call("HGET", M, "rel") == "1" then return {0} end
redis.call("HSET", M, "exp", fmt(now() + tonumber(ARGV[4])))
refresh()
return {1}`;

/** ARGV: member, ownerId, epoch, wakeInMs ("" = none). */
const RELEASE = `${PRELUDE}local epoch = tonumber(ARGV[3])
if redis.call("HGET", M, "owner") ~= ARGV[2] or geti("epoch", 0) ~= epoch or redis.call("HGET", M, "rel") == "1" then return {0} end
redis.call("HSET", M, "rel", "1")
if ARGV[4] ~= "" then redis.call("HSET", M, "wake", fmt(now() + tonumber(ARGV[4]))) end
refresh()
return {1}`;

/** ARGV: member, epoch, affinity ("" with clear = "1" unpins). */
const PIN = `${PRELUDE}if not owned(tonumber(ARGV[2])) then return {"OWN"} end
if ARGV[4] == "1" then redis.call("HDEL", M, "aff") else redis.call("HSET", M, "aff", ARGV[3]) end
return {"OK"}`;

/** ARGV: member, hostId, ttlMs. Uses KEYS[9] only. */
const MARK = `${PRELUDE}redis.call("HSET", HOSTS, ARGV[2], fmt(now() + tonumber(ARGV[3])))
return {"OK"}`;

/** ARGV: member, harness, inputId, record JSON. */
const OFFER = `${PRELUDE}local harness, id, rec = ARGV[2], ARGV[3], ARGV[4]
if redis.call("HGET", M, "del") == "1" then return {"deleted"} end
local prev = redis.call("HGET", OFFERS, id)
if prev then
  if prev == rec then return {"duplicate"} end
  return {"conflict"}
end
local n = redis.call("HINCRBY", M, "oseq", 1)
redis.call("HSET", OFFERS, id, rec)
redis.call("HSET", INFO, id, fmt(now()))
redis.call("ZADD", PEND, fmt(n), id)
if redis.call("HEXISTS", M, "laneH") == 0 then
  redis.call("HSET", M, "laneH", redis.call("HGET", M, "harness") or harness)
end
local tick = redis.call("INCR", TICK)
refresh()
return {"offered", tick}`;

/** Pending offers in offer order, as ~id, ~record, ~offeredAt triples ("~" keeps the client from parsing them). */
const LIST_OFFERS = `${PRELUDE}local ids = redis.call("ZRANGE", PEND, 0, -1)
local out = {}
for _, id in ipairs(ids) do
  out[#out + 1] = "~" .. id
  out[#out + 1] = "~" .. redis.call("HGET", OFFERS, id)
  out[#out + 1] = "~" .. redis.call("HGET", INFO, id)
end
return out`;

/** ARGV: member, epoch, snapshot JSON (seq first), seq. */
const PUT_SNAPSHOT = `${PRELUDE}if not owned(tonumber(ARGV[2])) then return {"OWN"} end
local seq = tonumber(ARGV[4])
local head, first = geti("head", 0), geti("first", 1)
if seq > head or seq < first - 1 then return {"RANGE", fmt(head), fmt(first)} end
redis.call("SET", SNAP, ARGV[3])
return {"OK"}`;

/** ARGV: member, epoch, beforeSeq. */
const TRUNCATE = `${PRELUDE}if not owned(tonumber(ARGV[2])) then return {"OWN"} end
local before = tonumber(ARGV[3])
local snap = redis.call("GET", SNAP)
local sseq = nil
if snap then sseq = tonumber(string.match(snap, '^{"seq":(%-?%d+)')) end
if not (sseq and sseq >= before - 1) then return {"NOSNAP"} end
if before - geti("first", 1) <= 0 then return {"OK"} end
redis.call("ZREMRANGEBYSCORE", RECS, "-inf", fmt(before - 1))
redis.call("HSET", M, "first", fmt(before))
return {"OK"}`;

const DELETE_LOG = `${PRELUDE}redis.call("DEL", RECS, SNAP, OFFERS, INFO, PEND)
redis.call("HDEL", M, "head", "first", "aff", "wake", "laneH", "oseq")
redis.call("HSET", M, "del", "1")
if geti("epoch", 0) > 0 then redis.call("HSET", M, "rel", "1") end
local tick = redis.call("INCR", TICK)
refresh()
return {"OK", tick}`;

/** What `listLogsWithoutOwner` needs about one log. Strings are "~"-prefixed. */
const ORPHAN_INFO = `${PRELUDE}return {geti("epoch", 0), redis.call("HGET", M, "rel") == "1" and 1 or 0,
  geti("exp", 0), redis.call("ZCARD", PEND), "~" .. (redis.call("HGET", M, "harness") or ""),
  "~" .. (redis.call("HGET", M, "laneH") or ""), "~" .. (redis.call("HGET", M, "aff") or ""),
  redis.call("ZRANGE", PEND, 0, 0)[1] and 1 or 0}`;

const TIME = `return redis.call("TIME")`;

function assertMs(name: string, value: number, allowZero: boolean): void {
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new RangeError(
      `${name} must be ${allowZero ? "0 or more" : "more than 0"}, got ${value}.`,
    );
  }
}

/** The most records one `append` writes. Larger batches would outrun the Lua script time limit. */
const MAX_APPEND_RECORDS = 10_000;

const tilde = (v: unknown) => String(v).slice(1);

export interface UpstashLogStoreConfig {
  /**
   * How often `subscribe` checks Redis for writes from other machines (the REST API keeps no
   * blocking reads). Writes through the same store call listeners immediately.
   * @default 250
   */
  pollIntervalMs?: number;
}

interface Watch {
  listeners: Set<() => void>;
  /** The highest change counter the listeners were told about: each counter value is reported once. */
  reported: number;
  /** The highest counter a poll has read. The first read is the baseline, not a change. */
  observed: number;
  baselined: boolean;
  /** A poll is in flight: the next tick skips, so slow requests never pile up. */
  busy: boolean;
  timer?: ReturnType<typeof setInterval>;
}

/**
 * `LogStore` (the append-only session log of TanStack AI 1.0) on Upstash Redis: records, the
 * ownership fence with epochs, the input lane, snapshots, truncation, and worker affinity. Every
 * operation is one Lua script over one log's keys, so an `append` is atomic (batch + consumed
 * offers or nothing) and a compare-and-append on `seq`; the store clock is the Redis clock.
 * `subscribe` calls listeners right after a write through this store and polls a change counter
 * for writes from other machines. Checked against TanStack's `runPersistenceConformance` suite.
 */
export function redisLogStore(
  redis: Redis,
  prefix: string,
  config: UpstashLogStoreConfig = {},
): LogStore {
  const pollMs = config.pollIntervalMs ?? 250;
  const due = `${prefix}:logDue`;
  const hosts = `${prefix}:logHosts`;
  const keys = (logId: string) => {
    const b = `${prefix}:log:${encodeURIComponent(logId)}`;
    return [
      `${b}:meta`,
      `${b}:recs`,
      `${b}:snap`,
      `${b}:offers`,
      `${b}:info`,
      `${b}:pend`,
      `${b}:tick`,
      due,
      hosts,
    ];
  };
  const run = async (script: string, logId: string, args: (string | number)[] = []) => {
    assertId(logId, "logId");
    return (await redis.eval(script, keys(logId), [`~${logId}`, ...args.map(String)])) as unknown[];
  };

  const watches = new Map<string, Watch>();
  const fire = (watch: Watch) => {
    for (const listener of [...watch.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("[ai-persistence] log listener failed", error);
      }
    }
  };
  /** A write through this store: remember its counter so the poll does not report it twice, then call listeners. */
  const changed = (logId: string, tick: unknown) => {
    const watch = watches.get(logId);
    if (!watch) return;
    // A poll may have seen this write's counter before the write's own reply arrived, and already
    // called the listeners for it: report each counter value once.
    if (Number(tick) <= watch.reported) return;
    watch.reported = Number(tick);
    fire(watch);
  };

  return {
    async append({ logId, seq, epoch, records, consumes = [] }) {
      if (records.length === 0 && consumes.length === 0) return;
      if (records.length > MAX_APPEND_RECORDS) {
        // One Lua script runs the whole batch; past the server's script time limit it is killed after
        // part of the writes, which would break the atomic-batch guarantee.
        throw new RangeError(
          `append takes at most ${MAX_APPEND_RECORDS} records per call, got ${records.length}. Split the batch.`,
        );
      }
      let badJson: unknown;
      let bad = false;
      const json = records.map((record) => {
        try {
          const text = JSON.stringify(record);
          if (typeof text !== "string" || !text.startsWith("{")) {
            throw new TypeError("A log record must become a JSON object.");
          }
          return text;
        } catch (error) {
          bad = true;
          badJson ??= error;
          return "{}";
        }
      });
      const res = await run(APPEND, logId, [
        epoch,
        seq,
        bad ? 1 : 0,
        json.length,
        consumes.length,
        ...json,
        ...consumes,
      ]);
      switch (res[0]) {
        case "OWN":
          throw new OwnershipLostError(logId, epoch);
        case "CONFLICT":
          throw new LogConflictError(logId, seq);
        case "TYPE":
          throw new TypeError(
            `Input ${JSON.stringify(String(res[1]))} is not a pending offer of log ${JSON.stringify(logId)}.`,
          );
        case "JSON":
          throw badJson;
        default:
          changed(logId, res[1]);
      }
    },

    async read({ logId, after = 0, limit }) {
      const res = await run(READ, logId, [after, limit ?? -1]);
      if (res[0] === "TRUNC") throw new LogTruncatedError(logId, Number(res[1]));
      return res.slice(1).map((row): LogEntry => {
        const text = String(row);
        const split = text.indexOf(":");
        return {
          seq: Number(text.slice(0, split)),
          record: JSON.parse(text.slice(split + 1)) as LogRecord,
        };
      });
    },

    subscribe({ logId, listener }) {
      let watch = watches.get(logId);
      if (!watch) {
        const created: Watch = {
          listeners: new Set(),
          reported: 0,
          observed: 0,
          baselined: false,
          busy: false,
        };
        watch = created;
        watches.set(logId, created);
        const tickKey = keys(logId)[6]!;
        // The first successful read of the counter is the baseline; later reads above it are writes
        // from other machines. A failed read (a REST blip) just tries again on the next tick.
        const check = async () => {
          if (created.busy) return;
          created.busy = true;
          try {
            const tick = Number((await redis.get<number>(tickKey)) ?? 0);
            if (watches.get(logId) !== created) return;
            if (!created.baselined) {
              // Not marked as reported: if this read already includes a write made through this store,
              // that write's own reply still has to call the listeners.
              created.baselined = true;
              created.observed = Math.max(created.observed, tick);
            } else if (tick > created.observed) {
              created.observed = tick;
              if (tick > created.reported) {
                created.reported = tick;
                fire(created);
              }
            }
          } catch {
            // retried on the next tick
          } finally {
            created.busy = false;
          }
        };
        created.timer = setInterval(() => void check(), pollMs);
        created.timer.unref?.();
        void check();
      }
      watch.listeners.add(listener);
      const current = watch;
      return () => {
        current.listeners.delete(listener);
        if (current.listeners.size === 0 && watches.get(logId) === current) {
          watches.delete(logId);
          if (current.timer) clearInterval(current.timer);
        }
      };
    },

    async acquireOwnership({ logId, harness, ownerId, ttlMs, affinity }) {
      assertMs("ttlMs", ttlMs, false);
      const res = await run(ACQUIRE, logId, [
        harness,
        ownerId,
        ttlMs,
        affinity ?? "",
        affinity === undefined ? 0 : 1,
      ]);
      if (res[0] === "NULL") return null;
      return Number(res[2]) === 1
        ? { epoch: Number(res[1]), expired: true }
        : { epoch: Number(res[1]) };
    },

    async renewOwnership({ logId, ownerId, epoch, ttlMs }) {
      assertMs("ttlMs", ttlMs, false);
      return Number((await run(RENEW, logId, [ownerId, epoch, ttlMs]))[0]) === 1;
    },

    async releaseOwnership({ logId, ownerId, epoch, wakeInMs }) {
      if (wakeInMs !== undefined) assertMs("wakeInMs", wakeInMs, true);
      await run(RELEASE, logId, [ownerId, epoch, wakeInMs ?? ""]);
    },

    async pinToWorkers({ logId, epoch, affinity }) {
      const res = await run(PIN, logId, [epoch, affinity ?? "", affinity === null ? 1 : 0]);
      if (res[0] === "OWN") throw new OwnershipLostError(logId, epoch);
    },

    async markHostAlive({ hostId, ttlMs }) {
      assertMs("ttlMs", ttlMs, false);
      assertId(hostId, "hostId");
      // MARK touches only the shared hosts hash; it still takes a log's key tuple, so use a fixed one.
      await redis.eval(MARK, keys("_hosts"), ["~_hosts", hostId, String(ttlMs)]);
    },

    async listLogsWithoutOwner({ limit, harnesses, affinity }) {
      if (limit <= 0) return [];
      const [sec, usec] = (await redis.eval(TIME, [], [])) as [string, string];
      const now = Number(sec) * 1000 + Math.floor(Number(usec) / 1000);
      const out: OrphanedLog[] = [];
      const batch = Math.max(limit * 2, 50);
      for (let offset = 0; out.length < limit; offset += batch) {
        const members = await redis.zrange<(string | number)[]>(
          due,
          "-inf" as unknown as number,
          now,
          { byScore: true, offset, count: batch },
        );
        const infos = await Promise.all(
          members.map(async (m) => {
            const logId = tilde(m);
            return { logId, info: (await run(ORPHAN_INFO, logId)) as unknown[] };
          }),
        );
        for (const { logId, info } of infos) {
          if (out.length >= limit) break;
          const [epoch, released, exp, pending, harness, laneHarness, pin] = info as [
            number,
            number,
            number,
            number,
            string,
            string,
            string,
          ];
          const ownerHarness = tilde(harness);
          const owned = Number(epoch) > 0;
          let reason: OrphanedLog["reason"];
          let name: string;
          if (owned && Number(released) !== 1) {
            if (Number(exp) > now) continue;
            reason = "expired";
            name = ownerHarness;
          } else if (Number(pending) > 0) {
            reason = "offered";
            name = ownerHarness || tilde(laneHarness);
          } else {
            reason = "wake";
            name = ownerHarness;
          }
          if (harnesses !== undefined && !harnesses.includes(name)) continue;
          const pinned = tilde(pin);
          if (pinned !== "" && pinned !== affinity) {
            const beat = await redis.hget<number>(hosts, pinned);
            if (beat != null && Number(beat) > now) continue;
          }
          out.push({ logId, harness: name, reason });
        }
        if (members.length < batch) break;
      }
      return out;
    },

    async offerInput({ logId, harness, inputId, record }) {
      assertId(inputId, "inputId");
      const text = JSON.stringify(record);
      if (typeof text !== "string" || !text.startsWith("{")) {
        throw new TypeError("A log record must become a JSON object.");
      }
      const res = await run(OFFER, logId, [harness, inputId, text]);
      if (res[0] === "offered") changed(logId, res[1]);
      return res[0] as OfferResult;
    },

    async listOfferedInputs({ logId }) {
      const flat = await run(LIST_OFFERS, logId);
      const out: OfferedInput[] = [];
      for (let i = 0; i < flat.length; i += 3) {
        out.push({
          inputId: tilde(flat[i]),
          record: JSON.parse(tilde(flat[i + 1])) as LogRecord,
          offeredAt: Number(tilde(flat[i + 2])),
        });
      }
      return out;
    },

    async getSnapshot({ logId }) {
      assertId(logId, "logId");
      return (await redis.get<LogSnapshot>(keys(logId)[2]!)) ?? null;
    },

    async putSnapshot({ logId, epoch, seq, version, state }) {
      const text = JSON.stringify({ seq, version, state: state ?? null });
      const res = await run(PUT_SNAPSHOT, logId, [epoch, text, seq]);
      if (res[0] === "OWN") throw new OwnershipLostError(logId, epoch);
      if (res[0] === "RANGE") {
        const head = Number(res[1]);
        const first = Number(res[2]);
        throw new RangeError(
          seq > head
            ? `Snapshot position ${seq} is after the last position ${head} of log ${JSON.stringify(logId)}.`
            : `Snapshot position ${seq} is before position ${first - 1} of log ${JSON.stringify(logId)}. The log dropped the records before ${first}.`,
        );
      }
    },

    async truncate({ logId, epoch, beforeSeq }) {
      const res = await run(TRUNCATE, logId, [epoch, beforeSeq]);
      if (res[0] === "OWN") throw new OwnershipLostError(logId, epoch);
      if (res[0] === "NOSNAP") {
        throw new RangeError(
          `Log ${JSON.stringify(logId)} has no snapshot at position ${beforeSeq - 1} or later, so it keeps the records before ${beforeSeq}.`,
        );
      }
    },

    async deleteLog({ logId }) {
      const res = await run(DELETE_LOG, logId);
      changed(logId, res[1]);
    },
  };
}
