import type { Redis } from "@upstash/redis";
import { key, stableHash } from "./utils.js";

/**
 * Reject an empty/missing key part, or one containing the `:` key separator. `userId` and `toolName`
 * are both segments of the cache key `<prefix>:<userId>:<toolName>:<hash>`, so a blank one would
 * collapse unrelated users (or tools) into one shared entry — and a `:` would let segments slide across
 * the boundary (e.g. one user's entry colliding with another's), defeating the per-user scoping.
 */
function assertKeyPart(value: string | undefined, name: string): asserts value is string {
  if (value === undefined || value === "") {
    throw new Error(`ToolCache: \`${name}\` is required and must be a non-empty string.`);
  }
  if (value.includes(":")) {
    throw new Error(`ToolCache: \`${name}\` must not contain ':' (it is the key separator).`);
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

  /** Key shape: `<prefix>:<userId>:<toolName>:<hash>` — scoped per user, then per tool. */
  private entryKey(userId: string, toolName: string, args: unknown): string {
    assertKeyPart(userId, "userId");
    assertKeyPart(toolName, "toolName");
    return key(this.prefix, userId, toolName, stableHash(args));
  }

  /** Fetch a cached result, or `null` if absent. The hit is wrapped so a cached `null` is distinct. */
  async get<T>(userId: string, toolName: string, args: unknown): Promise<ToolCacheHit<T> | null> {
    const raw = await this.redis.get<string>(this.entryKey(userId, toolName, args));
    if (raw === null || raw === undefined) return null;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return { value: (parsed as { v: T }).v };
  }

  /** Cache a tool result. */
  async set<T>(
    userId: string,
    toolName: string,
    args: unknown,
    value: T,
    opts: { ttlSeconds?: number } = {},
  ): Promise<void> {
    const ttl = opts.ttlSeconds ?? this.ttlSeconds;
    await this.redis.set(
      this.entryKey(userId, toolName, args),
      JSON.stringify({ v: value }),
      ttl !== undefined ? { ex: ttl } : undefined,
    );
  }

  /** Invalidate a single cached result. */
  async invalidate(userId: string, toolName: string, args: unknown): Promise<void> {
    await this.redis.del(this.entryKey(userId, toolName, args));
  }

  /**
   * Wrap a tool's execute function so results are cached automatically. The returned function checks
   * the cache first, runs the original on a miss, and stores the result. The cache entry is scoped to
   * `userId` then `toolName`.
   */
  wrap<A, R>(
    userId: string,
    toolName: string,
    execute: (args: A) => Promise<R>,
    opts: { ttlSeconds?: number } = {},
  ): (args: A) => Promise<R> {
    return async (args: A) => {
      const hit = await this.get<R>(userId, toolName, args);
      if (hit) return hit.value;
      const result = await execute(args);
      await this.set(userId, toolName, args, result, opts);
      return result;
    };
  }
}
