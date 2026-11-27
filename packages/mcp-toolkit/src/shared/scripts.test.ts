import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { RedisTaskStore } from "../tasks/backends/qstash.js";
import { buildScript } from "./scripts.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniquePrefix } from "../test-support.js";

const BACKENDS = ["../tasks/backends/qstash.ts", "../events/backends/qstash.ts"].map((p) =>
  readFileSync(join(import.meta.dirname, p), "utf8"),
);

describe("lua scripts", () => {
  it("are named uniquely and carry no shebang of their own", () => {
    const names = BACKENDS.flatMap((src) =>
      [...src.matchAll(/: LuaScript = \{\s*name: "([^"]+)"/g)].map((m) => m[1]!),
    );
    expect(names.sort()).toEqual([
      "events_subscription_put",
      "tasks_guarded_write",
      "tasks_respond",
    ]);
    for (const src of BACKENDS) expect(src).not.toContain("#!lua");
  });

  it("buildScript puts the name and key locking in a first-line shebang", () => {
    expect(buildScript({ name: "tasks_respond", script: "return 1" }, true)).toBe(
      "#!lua script_name=mcp-toolkit-js-tasks_respond flags=allow-key-locking\nreturn 1",
    );
    expect(buildScript({ name: "tasks_respond", script: "return 1" }, false)).toBe("return 1");
  });
});

describe.skipIf(!hasRedisCreds)("enableUpstashScriptFlags (live Redis)", () => {
  const redis = testRedis();
  const prefix = `${uniquePrefix("scriptFlags")}:`;
  afterAll(() => cleanupKeys(redis, prefix));

  for (const enableUpstashScriptFlags of [true, false]) {
    it(`${enableUpstashScriptFlags}: the guarded write runs on Upstash Redis`, async () => {
      const store = new RedisTaskStore({ redis, prefix, enableUpstashScriptFlags });
      const now = new Date().toISOString();
      const taskId = crypto.randomUUID();
      await store.create({
        taskId,
        status: "working",
        statusMessage: "Queued",
        createdAt: now,
        lastUpdatedAt: now,
        ttlMs: 60_000,
        pollIntervalMs: 1_000,
        name: "t",
        args: {},
        owner: "alice",
      });
      const settled = await store.settle(taskId, { status: "completed", statusMessage: "done" });
      expect(settled?.status).toBe("completed");
    });
  }
});
