/**
 * The Redis stores against a Redis server other than Upstash (Redis or Valkey behind SRH, see the
 * `non-upstash` CI job). Runs only when NON_UPSTASH_REDIS_REST_URL / _TOKEN are set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Redis } from "@upstash/redis";
import { RedisTaskStore } from "../tasks/backends/qstash.js";
import { RedisSubscriptionStore } from "../events/backends/qstash.js";
import { uniquePrefix } from "../test-support.js";
import type { Task } from "../tasks/types.js";
import type { Subscription } from "../events/types.js";

const url = process.env.NON_UPSTASH_REDIS_REST_URL;
const token = process.env.NON_UPSTASH_REDIS_REST_TOKEN;

const task = (): Task => {
  const now = new Date().toISOString();
  return {
    taskId: crypto.randomUUID(),
    status: "working",
    statusMessage: "Queued",
    createdAt: now,
    lastUpdatedAt: now,
    ttlMs: 60_000,
    pollIntervalMs: 1_000,
    name: "t",
    args: {},
    owner: "alice",
  };
};

describe.skipIf(!url || !token)("lua scripts on a Redis other than Upstash", () => {
  const prefix = uniquePrefix("nonUpstash");
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  for (const enableUpstashScriptFlags of [undefined, false]) {
    it(`${enableUpstashScriptFlags}: tasks settle and subscriptions are stored`, async () => {
      const redis = new Redis({ url: url!, token: token! });
      const store = new RedisTaskStore({ redis, prefix, enableUpstashScriptFlags });
      const t = task();
      await store.create(t);
      expect((await store.settle(t.taskId, { status: "completed" }))?.status).toBe("completed");
      expect((await store.settle(t.taskId, { status: "failed" }))?.status).toBe("completed");

      const subs = new RedisSubscriptionStore({ redis, prefix, enableUpstashScriptFlags });
      const sub: Subscription = {
        id: `sub_${crypto.randomUUID()}`,
        event: "e",
        args: {},
        url: "https://example.com/hook",
        encryptedSecret: "x",
        subscriber: "alice",
        createdAt: new Date().toISOString(),
        expiresAt: Date.now() + 60_000,
      };
      expect(await subs.put(sub, { limit: 8 })).toBe(true);
    });
  }

  it("true: the server's rejection is thrown", async () => {
    const redis = new Redis({ url: url!, token: token! });
    const store = new RedisTaskStore({ redis, prefix, enableUpstashScriptFlags: true });
    const t = task();
    await store.create(t);
    await expect(store.update(t.taskId, { statusMessage: "x" })).rejects.toThrow(
      /shebang|near '#'/,
    );
  });
});
