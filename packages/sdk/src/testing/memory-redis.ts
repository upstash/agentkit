import type { RedisLike, RedisSetOptions } from "../types.js";

interface Entry {
  value: unknown;
  expireAt?: number;
}

/**
 * A minimal, dependency-free in-memory implementation of {@link RedisLike} for tests. It mirrors the
 * semantics of the subset of Redis commands the SDK uses, including TTL expiry. Not concurrency-safe
 * and not for production use.
 */
export class MemoryRedis implements RedisLike {
  private store = new Map<string, Entry>();
  private clock: () => number;

  constructor(opts: { clock?: () => number } = {}) {
    this.clock = opts.clock ?? (() => Date.now());
  }

  /** Wipe all data. */
  flushall(): void {
    this.store.clear();
  }

  private live(k: string): Entry | undefined {
    const e = this.store.get(k);
    if (!e) return undefined;
    if (e.expireAt !== undefined && e.expireAt <= this.clock()) {
      this.store.delete(k);
      return undefined;
    }
    return e;
  }

  private asList(k: string): unknown[] {
    const e = this.live(k);
    if (!e) {
      const list: unknown[] = [];
      this.store.set(k, { value: list });
      return list;
    }
    if (!Array.isArray(e.value)) throw new Error(`WRONGTYPE: ${k} is not a list`);
    return e.value as unknown[];
  }

  private asHash(k: string): Map<string, unknown> {
    const e = this.live(k);
    if (!e) {
      const h = new Map<string, unknown>();
      this.store.set(k, { value: h });
      return h;
    }
    if (!(e.value instanceof Map)) throw new Error(`WRONGTYPE: ${k} is not a hash`);
    return e.value as Map<string, unknown>;
  }

  private asZset(k: string): { score: number; member: unknown }[] {
    const e = this.live(k);
    if (!e) {
      const z: { score: number; member: unknown }[] = [];
      this.store.set(k, { value: z });
      return z;
    }
    return e.value as { score: number; member: unknown }[];
  }

  async get<T = string>(k: string): Promise<T | null> {
    const e = this.live(k);
    return e ? (e.value as T) : null;
  }

  async set<T = string>(k: string, value: T, opts: RedisSetOptions = {}): Promise<unknown> {
    const exists = this.live(k) !== undefined;
    if (opts.nx && exists) return null;
    if (opts.xx && !exists) return null;
    const entry: Entry = { value };
    if (opts.ex !== undefined) entry.expireAt = this.clock() + opts.ex * 1000;
    if (opts.px !== undefined) entry.expireAt = this.clock() + opts.px;
    this.store.set(k, entry);
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n++;
    return n;
  }

  async exists(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) if (this.live(k)) n++;
    return n;
  }

  async expire(k: string, seconds: number): Promise<number> {
    const e = this.live(k);
    if (!e) return 0;
    e.expireAt = this.clock() + seconds * 1000;
    return 1;
  }

  async incr(k: string): Promise<number> {
    const e = this.live(k);
    const next = (e ? Number(e.value) : 0) + 1;
    this.store.set(k, { value: next, expireAt: e?.expireAt });
    return next;
  }

  async rpush<T = string>(k: string, ...values: T[]): Promise<number> {
    const list = this.asList(k);
    list.push(...values);
    return list.length;
  }

  async lpush<T = string>(k: string, ...values: T[]): Promise<number> {
    const list = this.asList(k);
    list.unshift(...[...values].reverse());
    return list.length;
  }

  async lrange<T = string>(k: string, start: number, stop: number): Promise<T[]> {
    const list = this.asList(k) as T[];
    const len = list.length;
    const s = start < 0 ? Math.max(len + start, 0) : start;
    const e = stop < 0 ? len + stop : stop;
    if (s > e || s >= len) return [];
    return list.slice(s, e + 1);
  }

  async ltrim(k: string, start: number, stop: number): Promise<unknown> {
    const list = this.asList(k);
    const len = list.length;
    const s = start < 0 ? Math.max(len + start, 0) : start;
    const e = stop < 0 ? len + stop : stop;
    const trimmed = s > e ? [] : list.slice(s, e + 1);
    this.store.set(k, { value: trimmed, expireAt: this.live(k)?.expireAt });
    return "OK";
  }

  async llen(k: string): Promise<number> {
    return this.asList(k).length;
  }

  async hset<T = unknown>(k: string, kv: Record<string, T>): Promise<number> {
    const h = this.asHash(k);
    let added = 0;
    for (const [field, val] of Object.entries(kv)) {
      if (!h.has(field)) added++;
      h.set(field, val);
    }
    return added;
  }

  async hget<T = unknown>(k: string, field: string): Promise<T | null> {
    const h = this.asHash(k);
    return h.has(field) ? (h.get(field) as T) : null;
  }

  async hgetall<T = unknown>(k: string): Promise<Record<string, T> | null> {
    const h = this.asHash(k);
    if (h.size === 0) return null;
    return Object.fromEntries(h) as Record<string, T>;
  }

  async hdel(k: string, ...fields: string[]): Promise<number> {
    const h = this.asHash(k);
    let n = 0;
    for (const f of fields) if (h.delete(f)) n++;
    return n;
  }

  async zadd<T = string>(
    k: string,
    ...members: { score: number; member: T }[]
  ): Promise<number | null> {
    const z = this.asZset(k);
    let added = 0;
    for (const m of members) {
      const existing = z.find((e) => e.member === m.member);
      if (existing) existing.score = m.score;
      else {
        z.push({ score: m.score, member: m.member });
        added++;
      }
    }
    z.sort((a, b) => a.score - b.score);
    return added;
  }

  async zrange<T = string>(k: string, start: number, stop: number): Promise<T[]> {
    const z = this.asZset(k);
    const len = z.length;
    const s = start < 0 ? Math.max(len + start, 0) : start;
    const e = stop < 0 ? len + stop : stop;
    if (s > e) return [];
    return z.slice(s, e + 1).map((m) => m.member) as T[];
  }

  async scan(
    cursor: string | number,
    opts: { match?: string; count?: number } = {},
  ): Promise<[string, string[]]> {
    // Single-pass scan: returns everything matching and a "0" cursor.
    void cursor;
    const all = [...this.store.keys()].filter((k) => this.live(k));
    const match = opts.match;
    const keys = match ? all.filter((k) => matchGlob(k, match)) : all;
    return ["0", keys];
  }
}

/** Tiny glob matcher supporting `*` and `?`, sufficient for Redis MATCH patterns in tests. */
function matchGlob(input: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  return re.test(input);
}
