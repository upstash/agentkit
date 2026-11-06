import type { Redis } from "@upstash/redis";
import type {
  SessionIndexEntry,
  SessionIndexKey,
  SessionIndexListOptions,
  SessionIndexPage,
  SessionIndexStore,
} from "@tanstack/ai-persistence";
import { KEY_LOCKING, assertId } from "./records.js";

/**
 * Write a session entry and keep the per-tenant index in step, optionally compare-and-set on the
 * revision. The stored document is `{"r":<revision>,"e":<entry>}`; the revision is drawn from a
 * counter that only grows, so a revision is never reused (not even after a `delete`).
 * KEYS: document, tenant index, revision counter.
 * ARGV: entry JSON, updatedAt (the index score), index member, "1" to compare, expected revision ("" = absent).
 * Returns the new revision, or -1 on a revision conflict.
 */
const UPSERT = `${KEY_LOCKING}local cur = redis.call("GET", KEYS[1])
if ARGV[4] == "1" then
  local r = ""
  if cur then r = string.match(cur, '^{"r":(%d+),') or "" end
  if r ~= ARGV[5] then return -1 end
end
local rev = redis.call("INCR", KEYS[3])
redis.call("SET", KEYS[1], '{"r":' .. rev .. ',"e":' .. ARGV[1] .. '}')
redis.call("ZADD", KEYS[2], ARGV[2], ARGV[3])
return rev`;

/** Remove an entry and its index member. KEYS: document, tenant index. ARGV: index member. */
const DELETE = `${KEY_LOCKING}redis.call("DEL", KEYS[1])
redis.call("ZREM", KEYS[2], ARGV[1])
return 1`;

interface StoredSession {
  r: number;
  e: SessionIndexEntry;
}

/** Index members start with "~", so the client never JSON-parses a numeric-looking thread id. */
const member = (threadId: string) => `~${threadId}`;
const threadOf = (m: unknown) => String(m).slice(1);

const utf8 = new TextEncoder();
function compareUtf8Bytes(a: string, b: string): number {
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}
/** Newest `updatedAt` first; equal `updatedAt` in `threadId` (UTF-8 byte) order. */
const bySessionOrder = (a: { updatedAt: number; threadId: string }, b: typeof a) =>
  b.updatedAt - a.updatedAt || compareUtf8Bytes(a.threadId, b.threadId);

function parseCursor(cursor: string): { updatedAt: number; threadId: string } {
  const split = cursor.indexOf(":");
  const updatedAt = Number(cursor.slice(0, split));
  if (split <= 0 || !Number.isFinite(updatedAt)) {
    throw new Error(`Invalid session index cursor: ${cursor}`);
  }
  return { updatedAt, threadId: cursor.slice(split + 1) };
}

/** Index ids per Redis round trip while a filtered `list` scans. */
const SCAN_BATCH = 200;

/**
 * `SessionIndexStore` on Upstash Redis: one `{revision, entry}` document per `(tenantId, threadId)`
 * and one sorted set per tenant (score `updatedAt`) so `list` reads newest-first without scanning
 * other tenants. Writes are single Lua scripts, so concurrent hosts cannot interleave an
 * `upsertIf`. Checked against TanStack's `runPersistenceConformance` suite.
 */
export function redisSessionIndexStore(redis: Redis, prefix: string): SessionIndexStore {
  const tenant = (t: string | undefined) => encodeURIComponent(t ?? "");
  const k = {
    doc: (key: SessionIndexKey) =>
      `${prefix}:session:${tenant(key.tenantId)}:${encodeURIComponent(key.threadId)}`,
    index: (t: string | undefined) => `${prefix}:sessions:${tenant(t)}`,
    counter: `${prefix}:sessionRevision`,
  };

  const load = async (key: SessionIndexKey): Promise<StoredSession | undefined> => {
    assertId(key.threadId, "threadId");
    return (await redis.get<StoredSession>(k.doc(key))) ?? undefined;
  };

  const write = async (
    entry: SessionIndexEntry,
    compare: { revision: string | null } | undefined,
  ): Promise<number> => {
    assertId(entry.threadId, "threadId");
    if (!Number.isFinite(entry.updatedAt)) {
      throw new Error(
        "@upstash/agentkit-tanstack-ai: session `updatedAt` must be a finite number.",
      );
    }
    return (await redis.eval(
      UPSERT,
      [k.doc(entry), k.index(entry.tenantId), k.counter],
      [
        JSON.stringify(entry),
        String(entry.updatedAt),
        member(entry.threadId),
        compare ? "1" : "0",
        compare?.revision ?? "",
      ],
    )) as number;
  };

  return {
    async get(key) {
      return (await load(key))?.e;
    },

    async getVersioned(key) {
      const stored = await load(key);
      return stored && { entry: stored.e, revision: String(stored.r) };
    },

    async upsert(entry) {
      await write(entry, undefined);
    },

    async upsertIf({ entry, revision }) {
      const result = await write(entry, { revision });
      return result === -1
        ? { ok: false, reason: "conflict" }
        : { ok: true, revision: String(result) };
    },

    async list(options: SessionIndexListOptions = {}): Promise<SessionIndexPage> {
      const { limit, cursor, parentThreadId, memberId, search, harness, withArchived } = options;
      const after = cursor === undefined ? undefined : parseCursor(cursor);
      const needle = search?.toLowerCase();
      const metadata = Object.entries(options.metadata ?? {});
      const matches = (e: SessionIndexEntry) =>
        (withArchived === true || e.archived !== true) &&
        (parentThreadId === undefined || (e.parentThreadId ?? null) === parentThreadId) &&
        (memberId === undefined || e.members.some((m) => m.userId === memberId)) &&
        (needle === undefined || (e.title?.toLowerCase().includes(needle) ?? false)) &&
        (harness === undefined || e.harness === harness) &&
        metadata.every(([key, value]) => (e.metadata as Record<string, unknown>)?.[key] === value);

      const index = k.index(options.tenantId);
      const want = limit === undefined ? Infinity : limit + 1;
      const found: SessionIndexEntry[] = [];
      let max = after ? String(after.updatedAt) : "+inf";

      // Walk the index newest-first in batches of whole `updatedAt` groups (a group is re-read in
      // full, so the `threadId` tie-break order is exact), loading and filtering each batch.
      while (found.length < want) {
        const flat = await redis.zrange<(string | number)[]>(
          index,
          max as unknown as number,
          "-inf" as unknown as number,
          {
            byScore: true,
            rev: true,
            withScores: true,
            offset: 0,
            count: SCAN_BATCH,
          },
        );
        let rows: { threadId: string; updatedAt: number }[] = [];
        for (let i = 0; i < flat.length; i += 2) {
          rows.push({ threadId: threadOf(flat[i]), updatedAt: Number(flat[i + 1]) });
        }
        const full = rows.length === SCAN_BATCH;
        const lastScore = rows.at(-1)?.updatedAt;
        if (full && lastScore !== undefined) {
          const group = await redis.zrange<(string | number)[]>(index, lastScore, lastScore, {
            byScore: true,
            rev: true,
            withScores: true,
          });
          rows = rows.filter((r) => r.updatedAt !== lastScore);
          for (let i = 0; i < group.length; i += 2) {
            rows.push({ threadId: threadOf(group[i]), updatedAt: Number(group[i + 1]) });
          }
        }
        rows.sort(bySessionOrder);
        if (after) rows = rows.filter((r) => bySessionOrder(after, r) < 0);
        if (rows.length > 0) {
          const docs = await redis.mget<(StoredSession | null)[]>(
            ...rows.map((r) => k.doc({ tenantId: options.tenantId, threadId: r.threadId })),
          );
          for (const doc of docs) if (doc && matches(doc.e)) found.push(doc.e);
        }
        if (!full || lastScore === undefined) break;
        max = `(${lastScore}`;
      }

      const page = limit === undefined ? found : found.slice(0, limit);
      const last = page.at(-1);
      const hasMore = limit !== undefined && found.length > limit && last !== undefined;
      return {
        entries: page,
        ...(hasMore ? { cursor: `${last.updatedAt}:${last.threadId}`, truncated: true } : {}),
      };
    },

    async delete(key) {
      assertId(key.threadId, "threadId");
      await redis.eval(DELETE, [k.doc(key), k.index(key.tenantId)], [member(key.threadId)]);
    },
  };
}
