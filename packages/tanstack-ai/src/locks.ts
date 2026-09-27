import type { Redis } from "@upstash/redis";
import { Redis as RedisClient } from "@upstash/redis";
import { RedisLock } from "@upstash/agentkit-sdk";
import type { LockStore } from "@tanstack/ai/locks";
import { addTelemetry } from "./telemetry.js";

export interface UpstashLocksConfig {
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /** Base key prefix. Defaults to `agentkit:tanstackLock`. */
  prefix?: string;
  /**
   * Lease lifetime without renewal, in ms. The lease is renewed while the critical section runs, so
   * this only bounds how long a crashed holder blocks the key.
   * @default 30000
   */
  leaseMs?: number;
  /**
   * How long a caller waits for a held key before `withLock` rejects.
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

/**
 * A distributed TanStack AI `LockStore` on Upstash Redis — the multi-instance replacement for
 * `InMemoryLockStore`. Pass it to `withLocks()`; anything that reads the locks capability (notably
 * `withSandbox`'s ensure step and the run driver's claim) then coordinates across server instances.
 *
 * Lease-backed, as the contract asks: the lease is renewed while the section runs, and the section's
 * `signal` aborts as soon as ownership can no longer be guaranteed.
 *
 * ```ts
 * import { withLocks } from "@tanstack/ai/locks";
 * import { upstashLocks } from "@upstash/agentkit-tanstack-ai";
 *
 * chat({ adapter, messages, middleware: [withLocks(upstashLocks()), withSandbox(sandbox)] });
 * ```
 */
export function upstashLocks(config: UpstashLocksConfig = {}): LockStore {
  const redis = config.redis ?? RedisClient.fromEnv();
  addTelemetry(redis, config.enableTelemetry);
  const lock = new RedisLock({
    redis,
    prefix: config.prefix ?? "agentkit:tanstackLock",
    ...(config.leaseMs !== undefined ? { leaseMs: config.leaseMs } : {}),
    ...(config.acquireTimeoutMs !== undefined ? { acquireTimeoutMs: config.acquireTimeoutMs } : {}),
    ...(config.retryDelayMs !== undefined ? { retryDelayMs: config.retryDelayMs } : {}),
    ...(config.enableTelemetry !== undefined ? { enableTelemetry: config.enableTelemetry } : {}),
  });
  return {
    withLock: (key, fn) => lock.withLock(key, (signal) => fn(signal)),
  };
}
