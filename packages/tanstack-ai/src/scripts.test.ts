import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { RedisLock } from "./locks/redis-lock.js";
import { EventLog } from "./stream/event-log.js";
import { SCRIPT_NAME_PREFIX } from "./scripts.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniquePrefix } from "./testing/test-support.js";

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });

describe("lua scripts", () => {
  const files = sources(import.meta.dirname);
  const names = files.flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/\blua\(\s*"([^"]+)"/g)].map((m) => m[1]!),
  );

  it("every script has a unique name within the server's 100-byte limit", () => {
    expect(names.length).toBeGreaterThan(30);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^[a-z_]+$/);
      expect(`${SCRIPT_NAME_PREFIX}-${name}`.length).toBeLessThanOrEqual(100);
    }
  });

  it("no script carries its own shebang: buildScript adds it", () => {
    for (const file of files) {
      if (file.endsWith("scripts.ts")) continue;
      expect(readFileSync(file, "utf8"), file).not.toContain("#!lua");
    }
  });
});

describe.skipIf(!hasRedisCreds)("enableUpstashScriptFlags: true (live Redis)", () => {
  const redis = testRedis();
  const prefix = uniquePrefix("scriptFlags");
  afterAll(() => cleanupKeys(redis, prefix));

  it("Upstash Redis accepts the named lock scripts", async () => {
    const lock = new RedisLock({ redis, prefix, enableUpstashScriptFlags: true });
    const lease = await lock.tryAcquire("k");
    expect(lease).not.toBeNull();
    expect(await lease!.extend()).toBe(true);
    expect(await lease!.release()).toBe(true);
  });

  it("Upstash Redis accepts the named event log script", async () => {
    const log = new EventLog<number>({ redis, prefix, enableUpstashScriptFlags: true });
    expect(await log.append("l", [1, 2])).toHaveLength(2);
  });

  it("false sends the scripts without flags and still works on Upstash Redis", async () => {
    const lock = new RedisLock({ redis, prefix, enableUpstashScriptFlags: false });
    const lease = await lock.tryAcquire("k2");
    expect(await lease!.release()).toBe(true);
  });
});
