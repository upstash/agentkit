/**
 * The script runner against a Redis server other than Upstash, reached over REST (for example
 * Redis or Valkey behind serverless-redis-http). Runs only when NON_UPSTASH_REDIS_REST_URL /
 * _TOKEN are set; not part of CI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Redis } from "@upstash/redis";
import { buildScript, createScriptRunner, lua } from "./scripts.js";
import { uniquePrefix } from "./test-support.js";

const url = process.env.NON_UPSTASH_REDIS_REST_URL;
const token = process.env.NON_UPSTASH_REDIS_REST_TOKEN;

const INCR = lua("test_incr", `return redis.call("INCR", KEYS[1])`);

/** A fresh client to the server, recording the script of every EVAL sent through it. */
const recordingClient = () => {
  const client = new Redis({ url: url!, token: token! });
  const sent: string[] = [];
  const redis = {
    eval: (script: string, keys: string[], args: unknown[]) => {
      sent.push(script);
      return client.eval(script, keys, args);
    },
  };
  return { redis, sent };
};

describe.skipIf(!url || !token)("createScriptRunner (Redis other than Upstash)", () => {
  const prefix = uniquePrefix("scriptsNonUpstash");
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("the server rejects the flags", async () => {
    const { redis } = recordingClient();
    await expect(redis.eval(buildScript(INCR, "p", true), [`${prefix}:raw`], [])).rejects.toThrow();
  });

  it("unset: sends the flags once, then runs without them", async () => {
    const { redis, sent } = recordingClient();
    const run = createScriptRunner(redis, { prefix: "agentkit-test-js" });
    expect(await run(INCR, [`${prefix}:a`], [])).toBe(1);
    expect(await run(INCR, [`${prefix}:a`], [])).toBe(2);
    expect(sent).toEqual([
      `#!lua script_name=agentkit-test-js-test_incr flags=allow-key-locking\n${INCR.script}`,
      INCR.script,
      INCR.script,
    ]);
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1); // once per process
  });

  it("false: never sends the flags", async () => {
    const { redis, sent } = recordingClient();
    const run = createScriptRunner(redis, { prefix: "p", enableUpstashScriptFlags: false });
    expect(await run(INCR, [`${prefix}:b`], [])).toBe(1);
    expect(sent).toEqual([INCR.script]);
  });

  it("true: throws the server's rejection, even on a client that fell back before", async () => {
    const { redis, sent } = recordingClient();
    await createScriptRunner(redis, { prefix: "p" })(INCR, [`${prefix}:c`], []); // falls back
    const strict = createScriptRunner(redis, { prefix: "p", enableUpstashScriptFlags: true });
    await expect(strict(INCR, [`${prefix}:c`], [])).rejects.toThrow(/shebang|near '#'/);
    expect(sent.at(-1)).toBe(buildScript(INCR, "p", true));
  });
});
