import { randomUUID } from "node:crypto";
import type { Redis } from "@upstash/redis";
import { addTelemetry } from "./telemetry.js";

/**
 * Every script runs with `allow-key-locking`, so Upstash locks only the keys it declares rather than
 * the whole database. That makes declaring every touched key in `KEYS` mandatory (an undeclared key
 * is an error), which these scripts do.
 *
 * Acquire: take the lease key only if it is free, and on success bump a per-key counter that never
 * expires. The counter is the **fencing token** — strictly increasing across every holder the key
 * ever had, so a holder that stalled past its lease can compare its token against the store and
 * learn it was superseded (a lease alone tells the winner it won, but gives a loser nothing to read).
 */
const ACQUIRE = `#!lua flags=allow-key-locking
if redis.call("SET", KEYS[1], ARGV[1], "NX", "PX", ARGV[2]) then
  return redis.call("INCR", KEYS[2])
end
return 0`;

/** Release only our own lease: a holder whose lease expired must not delete the next holder's. */
const RELEASE = `#!lua flags=allow-key-locking
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0`;

/** Extend only our own lease — the same ownership check as release. */
const EXTEND = `#!lua flags=allow-key-locking
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0`;

export interface RedisLockConfig {
  /** Upstash Redis client. */
  redis: Redis;
  /** Base key prefix. Defaults to `agentkit:lock`. */
  prefix?: string;
  /**
   * How long a lease lives without renewal, in ms. `withLock` renews it in the background, so this
   * only bounds how long a crashed holder blocks the key.
   * @default 30000
   */
  leaseMs?: number;
  /**
   * How long `withLock` keeps retrying a held key before throwing {@link LockAcquireTimeoutError}.
   * @default 30000
   */
  acquireTimeoutMs?: number;
  /**
   * Delay between acquire attempts while the key is held, in ms.
   * @default 100
   */
  retryDelayMs?: number;
  /**
   * Report the sdk name + version to Upstash as a header on the requests made by your redis client.
   * Can also be disabled with the `UPSTASH_DISABLE_TELEMETRY` env var. Defaults to `true`.
   */
  enableTelemetry?: boolean;
}

/** A held lease. */
export interface LockLease {
  /** The lock key (without the prefix). */
  key: string;
  /** Opaque per-acquisition owner token. */
  token: string;
  /**
   * Strictly increasing across every acquisition of this key, ever. Store it next to anything the
   * holder writes and reject writes carrying an older one to make stale holders harmless.
   */
  fencingToken: number;
  /** Push the expiry out by `leaseMs` (or the configured lease). `false` = the lease was lost. */
  extend(leaseMs?: number): Promise<boolean>;
  /** Release the lease if we still hold it. `false` = it had already expired or been taken. */
  release(): Promise<boolean>;
}

/** Thrown by `withLock` when the key stays held past `acquireTimeoutMs`. */
export class LockAcquireTimeoutError extends Error {
  constructor(
    readonly key: string,
    readonly timeoutMs: number,
  ) {
    super(`RedisLock: could not acquire "${key}" within ${timeoutMs}ms.`);
    this.name = "LockAcquireTimeoutError";
  }
}

/** The reason `withLock`'s signal aborts with when renewal finds the lease gone. */
export class LockLostError extends Error {
  constructor(readonly key: string) {
    super(`RedisLock: lease on "${key}" was lost before the critical section finished.`);
    this.name = "LockLostError";
  }
}

function assertKey(key: string): void {
  if (typeof key !== "string" || key === "") {
    throw new Error("RedisLock: `key` is required and must be a non-empty string.");
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A distributed mutex on Upstash Redis: a lease key (`SET NX PX`) plus a fencing token, with
 * ownership-checked release/extend in Lua. Works over the REST API (every operation is a single
 * command or one `EVAL`, so it needs no connection-scoped state like `WATCH`).
 *
 * Keys: `<prefix>:<key>` (the lease) and `<prefix>:fence:<key>` (the never-expiring counter).
 *
 * ```ts
 * const lock = new RedisLock({ redis });
 * await lock.withLock("thread:42", async (signal) => {
 *   // only one process at a time gets here; stop writing if `signal` aborts (lease lost)
 * });
 * ```
 */
export class RedisLock {
  private redis: Redis;
  private prefix: string;
  private leaseMs: number;
  private acquireTimeoutMs: number;
  private retryDelayMs: number;

  constructor(config: RedisLockConfig) {
    this.redis = config.redis;
    addTelemetry(config.redis, { enabled: config.enableTelemetry });
    this.prefix = config.prefix ?? "agentkit:lock";
    this.leaseMs = config.leaseMs ?? 30_000;
    this.acquireTimeoutMs = config.acquireTimeoutMs ?? 30_000;
    this.retryDelayMs = config.retryDelayMs ?? 100;
  }

  private leaseKey(key: string): string {
    return `${this.prefix}:${key}`;
  }

  private fenceKey(key: string): string {
    return `${this.prefix}:fence:${key}`;
  }

  /** One acquire attempt. Returns the lease, or `null` when the key is held. */
  async tryAcquire(key: string, opts: { leaseMs?: number } = {}): Promise<LockLease | null> {
    assertKey(key);
    const leaseMs = opts.leaseMs ?? this.leaseMs;
    const token = randomUUID();
    const leaseKey = this.leaseKey(key);
    const fencingToken = Number(
      await this.redis.eval(ACQUIRE, [leaseKey, this.fenceKey(key)], [token, String(leaseMs)]),
    );
    if (!fencingToken) return null;
    const redis = this.redis;
    return {
      key,
      token,
      fencingToken,
      extend: async (ms?: number) =>
        Number(await redis.eval(EXTEND, [leaseKey], [token, String(ms ?? leaseMs)])) === 1,
      release: async () => Number(await redis.eval(RELEASE, [leaseKey], [token])) === 1,
    };
  }

  /**
   * Acquire, retrying every `retryDelayMs` until `acquireTimeoutMs` (then
   * {@link LockAcquireTimeoutError}). Pass `signal` to give up early.
   */
  async acquire(
    key: string,
    opts: { leaseMs?: number; acquireTimeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<LockLease> {
    const timeoutMs = opts.acquireTimeoutMs ?? this.acquireTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      opts.signal?.throwIfAborted();
      const lease = await this.tryAcquire(
        key,
        opts.leaseMs !== undefined ? { leaseMs: opts.leaseMs } : {},
      );
      if (lease) return lease;
      if (Date.now() >= deadline) throw new LockAcquireTimeoutError(key, timeoutMs);
      await sleep(Math.min(this.retryDelayMs, Math.max(0, deadline - Date.now())));
    }
  }

  /**
   * Run `fn` while holding `key`. The lease is renewed every third of its lifetime; if a renewal finds
   * it gone (expired after a stall, or taken), `signal` aborts with {@link LockLostError} — stop
   * externally visible writes when it does. The lease is released when `fn` settles.
   */
  async withLock<T>(
    key: string,
    fn: (signal: AbortSignal, lease: LockLease) => Promise<T>,
    opts: { leaseMs?: number; acquireTimeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const lease = await this.acquire(key, opts);
    const leaseMs = opts.leaseMs ?? this.leaseMs;
    const controller = new AbortController();
    let renewing = false;
    const timer = setInterval(
      () => {
        if (renewing || controller.signal.aborted) return;
        renewing = true;
        lease
          .extend(leaseMs)
          .then((held) => {
            if (!held) controller.abort(new LockLostError(key));
          })
          // A failed renewal is not proof of loss, but ownership can no longer be guaranteed.
          .catch(() => controller.abort(new LockLostError(key)))
          .finally(() => {
            renewing = false;
          });
      },
      Math.max(10, Math.floor(leaseMs / 3)),
    );
    // Never keep the process alive just to renew a lease.
    (timer as { unref?: () => void }).unref?.();
    try {
      return await fn(controller.signal, lease);
    } finally {
      clearInterval(timer);
      await lease.release().catch(() => false);
    }
  }
}
