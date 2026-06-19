import type { Redis } from "@upstash/redis";
import { key, stableHash } from "./utils.js";

export interface ToolCacheConfig {
  redis: Redis;
  /** Key prefix; defaults to `agentkit:tool`. */
  namespace?: string;
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
  private namespace: string;
  private ttlSeconds?: number;

  constructor(config: ToolCacheConfig) {
    this.redis = config.redis;
    this.namespace = config.namespace ?? "agentkit:tool";
    this.ttlSeconds = config.ttlSeconds;
  }

  private entryKey(toolName: string, args: unknown): string {
    return key(this.namespace, toolName, stableHash(args));
  }

  /** Fetch a cached result, or `null` if absent. The hit is wrapped so a cached `null` is distinct. */
  async get<T>(toolName: string, args: unknown): Promise<ToolCacheHit<T> | null> {
    const raw = await this.redis.get<string>(this.entryKey(toolName, args));
    if (raw === null || raw === undefined) return null;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return { value: (parsed as { v: T }).v };
  }

  /** Cache a tool result. */
  async set<T>(
    toolName: string,
    args: unknown,
    value: T,
    opts: { ttlSeconds?: number } = {},
  ): Promise<void> {
    const ttl = opts.ttlSeconds ?? this.ttlSeconds;
    await this.redis.set(
      this.entryKey(toolName, args),
      JSON.stringify({ v: value }),
      ttl !== undefined ? { ex: ttl } : undefined,
    );
  }

  /** Invalidate a single cached result. */
  async invalidate(toolName: string, args: unknown): Promise<void> {
    await this.redis.del(this.entryKey(toolName, args));
  }

  /**
   * Wrap a tool's execute function so results are cached automatically. The returned function checks
   * the cache first, runs the original on a miss, and stores the result.
   */
  wrap<A, R>(
    toolName: string,
    execute: (args: A) => Promise<R>,
    opts: { ttlSeconds?: number } = {},
  ): (args: A) => Promise<R> {
    return async (args: A) => {
      const hit = await this.get<R>(toolName, args);
      if (hit) return hit.value;
      const result = await execute(args);
      await this.set(toolName, args, result, opts);
      return result;
    };
  }
}
