/**
 * Lua scripts with Upstash's script flags. The same logic as `@upstash/agentkit-sdk`'s scripts
 * module, kept here because this package depends on none of the agentkit packages.
 */

/** Minimal shape of the redis client needed to run scripts. Matches `@upstash/redis`'s `Redis`. */
type EvalCapableRedis = {
  eval: (script: string, keys: string[], args: unknown[]) => Promise<unknown>;
};

/** Scripts of this package are named `mcp-toolkit-js-<name>` in Upstash's script metrics. */
export const SCRIPT_NAME_PREFIX = "mcp-toolkit-js";

/** A lua script run by this package. Every one touches only its `KEYS`, so all use key locking. */
export interface LuaScript {
  /** Name of the script, sent as part of the `script_name` flag. Unique within this package. */
  name: string;
  /** The lua script without any shebang line. */
  script: string;
}

/** The `enableUpstashScriptFlags` option of the Redis stores. */
export type ScriptFlagsConfig = {
  /**
   * Whether to send the lua scripts with flags which only Upstash Redis understands: `script_name`,
   * which names each script (for example `mcp-toolkit-js-tasks_guarded_write`) in Upstash's script
   * metrics, and `flags=allow-key-locking`, which lets scripts for different keys run in parallel.
   *
   * - unset (default): send the flags. If the server rejects them, the scripts are sent again without
   *   them, a warning is printed once and the flags are left off for that Redis client from then on.
   * - `false`: never send the flags. Use this with Redis servers other than Upstash Redis.
   * - `true`: always send the flags and throw if the server rejects them.
   */
  enableUpstashScriptFlags?: boolean;
};

/**
 * Returns the script to send to Redis: with `withFlags`, prefixed by a shebang carrying
 * `script_name=mcp-toolkit-js-<name>` and `flags=allow-key-locking`.
 */
export const buildScript = (info: LuaScript, withFlags: boolean): string =>
  withFlags
    ? `#!lua script_name=${SCRIPT_NAME_PREFIX}-${info.name} flags=allow-key-locking\n${info.script}`
    : info.script;

/**
 * Errors which mean the server doesn't accept the Upstash flags in the shebang:
 * - Redis 7+ and Valkey: `Unexpected flag in script shebang: allow-key-locking` or
 *   `Unknown lua shebang option: script_name`
 * - Redis 6 and older, which don't know shebangs: a lua syntax error near `#`
 * - Upstash Redis servers which predate `script_name`: `Unknown metadata value: script_name=...`
 */
export const isScriptFlagError = (error: unknown): boolean => {
  const message = `${error}`;
  return (
    /shebang/i.test(message) ||
    message.includes("near '#'") ||
    message.includes("Unknown metadata value")
  );
};

/** Redis clients whose server rejected the Upstash flags. Scripts are sent without them from then on. */
const flagsRejected = new WeakSet<object>();
let warned = false;

const warnFlagsRejected = () => {
  if (warned) return;
  warned = true;
  console.warn(
    "[Upstash MCP Toolkit] Your Redis database doesn't support the flags the scripts are sent " +
      "with to improve performance, so the scripts are sent without them. Set " +
      "`enableUpstashScriptFlags: false` in the store config to send the scripts without the " +
      "flags from the start and to hide this warning.",
  );
};

/**
 * Runs the script with EVAL. Unless `enableUpstashScriptFlags` is false it is sent with the Upstash
 * flags; if that option is unset and the server rejects them, the script is run again without them,
 * a warning is printed once, and the flags are left off for that client from then on.
 */
export const evalScript = async <T>(
  redis: unknown,
  enableUpstashScriptFlags: boolean | undefined,
  info: LuaScript,
  keys: string[],
  args: unknown[],
): Promise<T> => {
  const client = redis as EvalCapableRedis;
  // `true` always sends the flags, even to a client which rejected them for another store.
  const withFlags =
    enableUpstashScriptFlags === true ||
    (enableUpstashScriptFlags !== false && !flagsRejected.has(client));
  if (!withFlags) return (await client.eval(info.script, keys, args)) as T;
  try {
    return (await client.eval(buildScript(info, true), keys, args)) as T;
  } catch (error) {
    if (enableUpstashScriptFlags === undefined && isScriptFlagError(error)) {
      flagsRejected.add(client);
      warnFlagsRejected();
      return (await client.eval(info.script, keys, args)) as T;
    }
    throw error;
  }
};
