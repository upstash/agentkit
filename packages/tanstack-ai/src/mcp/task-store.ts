import type { Redis } from "@upstash/redis";
import { Redis as RedisClient } from "@upstash/redis";
import type { TaskStore } from "@tanstack/ai-mcp/server";
import { addTelemetry } from "../telemetry.js";

export interface UpstashMcpTaskStoreConfig {
  /** Upstash Redis client. Defaults to `Redis.fromEnv()`. */
  redis?: Redis;
  /** Base key prefix. Defaults to `agentkit:tanstack`. */
  prefix?: string;
  /**
   * Expire a task record this many seconds after its last write. Omit to keep records until
   * `delete`. Clients poll a task until it settles and then read its result, so keep it well above
   * your longest task plus the time a client may take to come back for the result.
   */
  ttlSeconds?: number;
  /** Set `false` to opt out of the telemetry header. */
  enableTelemetry?: boolean;
}

/**
 * `TaskStore` for `createMCPServer({ taskStore })` from `@tanstack/ai-mcp/server` on Upstash Redis:
 * MCP task records survive a restart and any server instance can answer `tasks/get` and
 * `tasks/result` for a task another instance started. Values are stored as JSON.
 *
 * Cancelling still aborts the task's work only on the instance that runs it (TanStack keeps the
 * `AbortController` in process); another instance records the cancellation.
 *
 * @example
 * ```ts
 * import { createMCPServer } from "@tanstack/ai-mcp/server";
 * import { upstashMcpTaskStore } from "@upstash/agentkit-tanstack-ai/mcp";
 *
 * const server = createMCPServer({ name: "tools", version: "1.0.0", taskStore: upstashMcpTaskStore() });
 * ```
 */
export function upstashMcpTaskStore<Value = unknown>(
  config: UpstashMcpTaskStoreConfig = {},
): TaskStore<Value> {
  const redis = config.redis ?? RedisClient.fromEnv();
  addTelemetry(redis, config.enableTelemetry);
  const p = config.prefix ?? "agentkit:tanstack";
  const key = (id: string) => `${p}:mcp:task:${encodeURIComponent(id)}`;

  return {
    async get(id) {
      // Wrapped as `{ v }` so a bare string or number round-trips without the client re-parsing it.
      const doc = await redis.get<{ v: Value }>(key(id));
      return doc ? doc.v : null;
    },
    async set(id, value) {
      const doc = JSON.stringify({ v: value ?? null });
      if (config.ttlSeconds) await redis.set(key(id), doc, { ex: config.ttlSeconds });
      else await redis.set(key(id), doc);
    },
    async delete(id) {
      await redis.del(key(id));
    },
  };
}
