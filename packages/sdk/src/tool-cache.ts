import type { Redis } from "@upstash/redis";
import { key, stableHash } from "./utils.js";

/**
 * Reject an empty/missing per-call namespace. The namespace is the cache key prefix; a blank one would
 * collapse unrelated tools (and, for per-user keys, unrelated users) into one shared cache entry.
 */
function assertNamespace(namespace: string | undefined): asserts namespace is string {
  if (namespace === undefined || namespace === "") {
    throw new Error("ToolCache: `namespace` is required and must be a non-empty string.");
  }
}

export interface ToolCacheConfig {
  redis: Redis;
  /** Base key prefix; defaults to `agentkit:toolCache`. */
  prefix?: string;
  /** Default TTL (seconds) for cached results. Omit for no expiry. */
  ttlSeconds?: number;
}

/** A cached tool result. `null`/`undefined` results are cached too, hence the wrapper object. */
export interface ToolCacheHit<T> {
  value: T;
}

/**
 * Memoizes deterministic tool-call results in Redis, keyed by the tool name plus a stable hash of
 * its arguments. Saves repeated work (and cost) when an agent calls the same tool with the same
 * arguments — common with retries, parallel branches, and multi-step reasoning loops.
 */
export class ToolCache {
  private redis: Redis;
  private prefix: string;
  private ttlSeconds?: number;

  constructor(config: ToolCacheConfig) {
    this.redis = config.redis;
    this.prefix = config.prefix ?? "agentkit:toolCache";
    this.ttlSeconds = config.ttlSeconds;
  }

  /** Key shape: `<prefix>:<namespace>:<hash>` (namespace is the per-call cache key, e.g. the tool name). */
  private entryKey(namespace: string, args: unknown): string {
    assertNamespace(namespace);
    return key(this.prefix, namespace, stableHash(args));
  }

  /** Fetch a cached result, or `null` if absent. The hit is wrapped so a cached `null` is distinct. */
  async get<T>(namespace: string, args: unknown): Promise<ToolCacheHit<T> | null> {
    const raw = await this.redis.get<string>(this.entryKey(namespace, args));
    if (raw === null || raw === undefined) return null;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return { value: (parsed as { v: T }).v };
  }

  /** Cache a tool result. */
  async set<T>(
    namespace: string,
    args: unknown,
    value: T,
    opts: { ttlSeconds?: number } = {},
  ): Promise<void> {
    const ttl = opts.ttlSeconds ?? this.ttlSeconds;
    await this.redis.set(
      this.entryKey(namespace, args),
      JSON.stringify({ v: value }),
      ttl !== undefined ? { ex: ttl } : undefined,
    );
  }

  /** Invalidate a single cached result. */
  async invalidate(namespace: string, args: unknown): Promise<void> {
    await this.redis.del(this.entryKey(namespace, args));
  }

  /**
   * Wrap a tool's execute function so results are cached automatically. The returned function checks
   * the cache first, runs the original on a miss, and stores the result. `namespace` is the per-call
   * cache key (e.g. the tool name).
   */
  wrap<A, R>(
    namespace: string,
    execute: (args: A) => Promise<R>,
    opts: { ttlSeconds?: number } = {},
  ): (args: A) => Promise<R> {
    return async (args: A) => {
      const hit = await this.get<R>(namespace, args);
      if (hit) return hit.value;
      const result = await execute(args);
      await this.set(namespace, args, result, opts);
      return result;
    };
  }
}
