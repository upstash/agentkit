import type { Redis } from "@upstash/redis";
import { Redis as RedisClient } from "@upstash/redis";
import type { SandboxInstanceRecord, SandboxInstanceStore } from "@tanstack/ai-sandbox";
import { addTelemetry } from "../telemetry.js";

export interface UpstashSandboxInstanceStoreConfig {
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /** Base key prefix. Defaults to `agentkit:tanstack`. */
  prefix?: string;
  /**
   * Expire a record this many seconds after its last `upsert`. Omit to keep records until `delete`.
   * Set it to at least your provider's sandbox lifetime: a record that expires early makes the next
   * run create a new sandbox instead of resuming the old one.
   */
  ttlSeconds?: number;
  /** Set `false` to opt out of the telemetry header. */
  enableTelemetry?: boolean;
}

/**
 * `SandboxInstanceStore` (from `@tanstack/ai-sandbox`) on Upstash Redis: which provider sandbox (and
 * latest snapshot) belongs to a sandbox key, so any server can resume a thread's sandbox instead of
 * only the one that created it. One JSON document per key. Checked against
 * `runSandboxInstanceStoreConformance` from `@tanstack/ai-sandbox/testkit`.
 *
 * @example
 * ```ts
 * import { provideSandboxInstanceStore } from "@tanstack/ai-sandbox";
 * import { upstashSandboxInstanceStore } from "@upstash/agentkit-tanstack-ai/sandbox";
 *
 * provideSandboxInstanceStore(upstashSandboxInstanceStore());
 * ```
 */
export function upstashSandboxInstanceStore(
  config: UpstashSandboxInstanceStoreConfig = {},
): SandboxInstanceStore {
  const redis = config.redis ?? RedisClient.fromEnv();
  addTelemetry(redis, config.enableTelemetry);
  const p = config.prefix ?? "agentkit:tanstack";
  const key = (k: string) => `${p}:sandbox:instance:${encodeURIComponent(k)}`;

  return {
    async get(k) {
      return (await redis.get<SandboxInstanceRecord>(key(k))) ?? null;
    },
    async upsert(record) {
      // JSON drops `undefined` optional fields, so they read back absent, like the reference store.
      const value = JSON.stringify(record);
      if (config.ttlSeconds) await redis.set(key(record.key), value, { ex: config.ttlSeconds });
      else await redis.set(key(record.key), value);
    },
    async delete(k) {
      await redis.del(key(k));
    },
  };
}
