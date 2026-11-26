import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Redis } from "@upstash/redis";
import { buildScript, createScriptRunner, isScriptFlagError, lua } from "./scripts.js";
import { cleanupKeys, hasRedisCreds, testRedis, uniquePrefix } from "./test-support.js";

const INCR = lua("test_incr", `return redis.call("INCR", KEYS[1])`);

describe("buildScript", () => {
  it("adds the script name and allow-key-locking in a shebang on the first line", () => {
    expect(buildScript(INCR, "agentkit-test-js", true)).toBe(
      `#!lua script_name=agentkit-test-js-test_incr flags=allow-key-locking\n${INCR.script}`,
    );
  });

  it("leaves allow-key-locking off for scripts without key locking", () => {
    const time = lua("time", `return redis.call("TIME")`, { keyLocking: false });
    expect(buildScript(time, "p", true).split("\n")[0]).toBe("#!lua script_name=p-time");
  });

  it("returns the bare script without flags", () => {
    expect(buildScript(INCR, "p", false)).toBe(INCR.script);
  });
});

it("isScriptFlagError recognizes shebang rejections only", () => {
  expect(isScriptFlagError("ERR Unexpected flag in script shebang: allow-key-locking")).toBe(true);
  expect(isScriptFlagError("ERR Unknown lua shebang option: script_name")).toBe(true);
  expect(isScriptFlagError("ERR user_script:1: unexpected symbol near '#'")).toBe(true);
  expect(isScriptFlagError("ERR Unknown metadata value: script_name=x")).toBe(true);
  expect(isScriptFlagError("WRONGTYPE Operation against a key")).toBe(false);
  expect(isScriptFlagError("NOSCRIPT No matching script")).toBe(false);
});

describe.skipIf(!hasRedisCreds)("createScriptRunner (live Redis)", () => {
  const redis = testRedis();
  const prefix = uniquePrefix("scripts");
  let warn: ReturnType<typeof vi.spyOn>;

  /**
   * The real client, behind a server which refuses shebangs the way Redis 7+ and Valkey do: there
   * is no such server to test against over REST, so only the refusal is simulated.
   */
  const withoutShebangSupport = () => {
    const sent: string[] = [];
    const client = {
      eval: async (script: string, keys: string[], args: unknown[]) => {
        sent.push(script);
        if (script.startsWith("#!")) throw new Error("ERR Unknown lua shebang option: script_name");
        return redis.eval(script, keys, args);
      },
    } as unknown as Redis;
    return { client, sent };
  };

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());
  afterAll(() => cleanupKeys(redis, prefix));

  it("Upstash Redis accepts the flags", async () => {
    const run = createScriptRunner(redis, {
      prefix: "agentkit-test-js",
      enableUpstashScriptFlags: true,
    });
    expect(await run(INCR, [`${prefix}:a`], [])).toBe(1);
    expect(await run(INCR, [`${prefix}:a`], [])).toBe(2);
  });

  it("unset: falls back without the flags once rejected, warns once, and remembers it", async () => {
    const { client, sent } = withoutShebangSupport();
    const run = createScriptRunner(client, { prefix: "p" });
    expect(await run(INCR, [`${prefix}:b`], [])).toBe(1);
    expect(await run(INCR, [`${prefix}:b`], [])).toBe(2);
    expect(sent).toEqual([buildScript(INCR, "p", true), INCR.script, INCR.script]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("false: never sends the flags", async () => {
    const { client, sent } = withoutShebangSupport();
    const run = createScriptRunner(client, { prefix: "p", enableUpstashScriptFlags: false });
    expect(await run(INCR, [`${prefix}:c`], [])).toBe(1);
    expect(sent).toEqual([INCR.script]);
  });

  it("true: throws the server's rejection", async () => {
    const { client } = withoutShebangSupport();
    const run = createScriptRunner(client, { prefix: "p", enableUpstashScriptFlags: true });
    await expect(run(INCR, [`${prefix}:d`], [])).rejects.toThrow("shebang");
  });

  it("other errors are thrown without a retry", async () => {
    const run = createScriptRunner(redis, { prefix: "p" });
    await redis.set(`${prefix}:e`, "not a number");
    await expect(run(INCR, [`${prefix}:e`], [])).rejects.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});
