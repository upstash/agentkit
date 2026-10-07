import type { Redis } from "@upstash/redis";
import { Redis as RedisClient } from "@upstash/redis";
import { RedisLock } from "./redis-lock.js";
import type { RedisLockConfig } from "./redis-lock.js";
import type { LockStore } from "@tanstack/ai/locks";
import { addTelemetry } from "../telemetry.js";

/**
 * The core {@link RedisLockConfig} (lease, acquire timeout, retry delay), with `redis` optional.
 * `prefix` defaults to `agentkit:tanstackLock`.
 */
export type UpstashLocksConfig = Omit<RedisLockConfig, "redis"> & {
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
};

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
    ...config,
    redis,
    prefix: config.prefix ?? "agentkit:tanstackLock",
  });
  return { withLock: (key, fn) => lock.withLock(key, (signal) => fn(signal)) };
}
