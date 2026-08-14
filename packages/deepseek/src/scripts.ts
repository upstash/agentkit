/**
 * The two mutating Lua scripts behind this backend.
 *
 * The seam requires `appendBatch` to materialize a session's metadata and write
 * its first event batch **atomically** — a crash between them must not leave a
 * materialized-but-empty session. The SQLite backend gets that from a
 * transaction; here a single `EVAL` is the equivalent boundary, since Redis runs
 * a script to completion without interleaving.
 *
 * That atomicity has a useful consequence: this backend can never produce a
 * partially written record, so the torn-tail marker exists only to repair keys
 * damaged from outside the backend. `commitRepair` still implements truncation
 * rather than assuming it can't happen.
 *
 * @module @upstash/agentkit-deepseek/scripts
 */

/** Elements pushed per `RPUSH` call, bounding the Lua stack on large batches. */
const CHUNK = 500;

/**
 * Durably append a contiguous batch, materializing the session in the same
 * atomic step.
 *
 * `KEYS`: events list, meta hash, ids set.
 * `ARGV`: `[expectedFirstSeq, headerJson, incarnation, ttlSeconds, sessionId, ...eventJson]`.
 *
 * Guards the contiguous-seq contract at the storage layer, not just in the
 * coordinator's in-memory bookkeeping: `LLEN` IS the stored next-seq, so a batch
 * whose first seq disagrees is rejected before anything is written. That turns a
 * second writer for the same session (another process, a stale instance) into a
 * loud failure instead of a silently interleaved log.
 *
 * Returns the resulting log length.
 */
export const APPEND_BATCH = `
local expected = tonumber(ARGV[1])
local stored = redis.call('LLEN', KEYS[1])
if stored ~= expected then
  return redis.error_reply('AGENTKIT_SEQ_MISMATCH stored next-seq ' .. stored .. ', batch starts at ' .. expected)
end

redis.call('HSET', KEYS[2], 'meta', ARGV[2])
redis.call('HSETNX', KEYS[2], 'incarnation', ARGV[3])

local i = 6
while i <= #ARGV do
  local last = i + ${CHUNK - 1}
  if last > #ARGV then last = #ARGV end
  redis.call('RPUSH', KEYS[1], unpack(ARGV, i, last))
  i = last + 1
end

redis.call('HINCRBY', KEYS[2], 'revision', 1)
redis.call('SADD', KEYS[3], ARGV[5])

local ttl = tonumber(ARGV[4])
if ttl > 0 then
  redis.call('EXPIRE', KEYS[1], ttl)
  redis.call('EXPIRE', KEYS[2], ttl)
end

return redis.call('LLEN', KEYS[1])
`;

/**
 * Read one session's header fields and its event suffix atomically.
 *
 * `KEYS`: events list, meta hash. `ARGV`: `[fromSeq]`.
 *
 * One script rather than two round trips because the seam requires a returned
 * revision to identify exactly the returned header and events — separate reads
 * could straddle a concurrent append and describe a different prefix.
 *
 * `HMGET` yields `false` for a missing field, and a `false` inside a Lua table
 * truncates the reply, so the fields are checked before the table is built and
 * an incomplete hash reads as an absent session.
 */
export const READ_LOG = `
local fields = redis.call('HMGET', KEYS[2], 'meta', 'incarnation', 'revision')
if not fields[1] or not fields[2] or not fields[3] then return nil end
return { fields[1], fields[2], fields[3], redis.call('LRANGE', KEYS[1], tonumber(ARGV[1]), -1) }
`;

/**
 * Read one session's revision fields without touching its event log.
 *
 * `KEYS`: meta hash.
 */
export const READ_REVISION = `
local fields = redis.call('HMGET', KEYS[1], 'incarnation', 'revision')
if not fields[1] or not fields[2] then return nil end
return { fields[1], fields[2] }
`;

/**
 * Make a crash repair durable: truncate a torn tail and append synthetic closers.
 *
 * `KEYS`: events list, meta hash.
 * `ARGV`: `[tornFrom (-1 for none), ttlSeconds, ...closerJson]`.
 *
 * `tornFrom === 0` deletes the list outright — `LTRIM key 0 -1` would keep every
 * element, which is the opposite of the intent.
 *
 * Returns the resulting log length.
 */
export const COMMIT_REPAIR = `
local torn = tonumber(ARGV[1])
local changed = false

if torn >= 0 then
  if torn == 0 then
    redis.call('DEL', KEYS[1])
  else
    redis.call('LTRIM', KEYS[1], 0, torn - 1)
  end
  changed = true
end

local i = 3
while i <= #ARGV do
  local last = i + ${CHUNK - 1}
  if last > #ARGV then last = #ARGV end
  redis.call('RPUSH', KEYS[1], unpack(ARGV, i, last))
  i = last + 1
  changed = true
end

if changed then
  redis.call('HINCRBY', KEYS[2], 'revision', 1)
end

local ttl = tonumber(ARGV[2])
if ttl > 0 then
  if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('EXPIRE', KEYS[1], ttl) end
  redis.call('EXPIRE', KEYS[2], ttl)
end

return redis.call('LLEN', KEYS[1])
`;
