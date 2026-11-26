/**
 * Minimal shape of the redis client needed to run scripts. Matches `@upstash/redis`'s `Redis`.
 */
type EvalCapableRedis = {
  eval: (script: string, keys: string[], args: unknown[]) => Promise<unknown>;
};

/** A lua script run by an AgentKit package. */
export interface LuaScript {
  /**
   * Name of the script, sent to Upstash Redis as part of the `script_name` flag (see
   * {@link buildScript}). Unique within its package.
   */
  name: string;
  /** The lua script without any shebang line. */
  script: string;
  /**
   * Whether the script can run with the `allow-key-locking` flag. Only scripts which touch nothing
   * but the keys passed in KEYS can. Defaults to `true`.
   */
  keyLocking?: boolean;
}

/** Defines a {@link LuaScript}. */
export const lua = (
  name: string,
  script: string,
  options: { keyLocking?: boolean } = {},
): LuaScript => ({
  name,
  script,
  keyLocking: options.keyLocking ?? true,
});

/**
 * Returns the script to send to Redis.
 *
 * With `withFlags`, the script starts with a shebang carrying two flags which only Upstash Redis
 * understands:
 * - `script_name`: names the script in Upstash's script metrics, `<prefix>-<name>`, for example
 *   `agentkit-tanstack-ai-js-lock_acquire`
 * - `flags=allow-key-locking`: lets scripts for different keys run in parallel. Only added to
 *   scripts with `keyLocking`.
 */
export const buildScript = (info: LuaScript, prefix: string, withFlags: boolean): string => {
  if (!withFlags) return info.script;
  const flags = info.keyLocking === false ? "" : " flags=allow-key-locking";
  return `#!lua script_name=${prefix}-${info.name}${flags}\n${info.script}`;
};

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
    "[Upstash AgentKit] Your Redis database doesn't support the flags the scripts are sent with " +
      "to improve performance, so the scripts are sent without them. Set " +
      "`enableUpstashScriptFlags: false` in the AgentKit config to send the scripts without the " +
      "flags from the start and to hide this warning.",
  );
};

/** Runs a {@link LuaScript} with EVAL. */
export type ScriptRunner = <T = unknown>(
  info: LuaScript,
  keys: string[],
  args: unknown[],
) => Promise<T>;

/**
 * Returns a function which runs scripts on `redis`.
 *
 * Unless `enableUpstashScriptFlags` is false, each script is sent with the Upstash flags (see
 * {@link buildScript}). If `enableUpstashScriptFlags` is unset and the server rejects the flags, the
 * script is run again without them, a warning is printed once, and the flags are left off for that
 * client from then on.
 *
 * @param prefix the script name prefix of the package, `<package>-<language>`, for example
 *   `agentkit-tanstack-ai-js`
 */
export const createScriptRunner = (
  redis: unknown,
  options: { prefix: string; enableUpstashScriptFlags?: boolean },
): ScriptRunner => {
  const client = redis as EvalCapableRedis;
  const { prefix, enableUpstashScriptFlags } = options;
  return async <T>(info: LuaScript, keys: string[], args: unknown[]): Promise<T> => {
    const withFlags = enableUpstashScriptFlags !== false && !flagsRejected.has(client);
    if (!withFlags) {
      return (await client.eval(info.script, keys, args)) as T;
    }
    try {
      return (await client.eval(buildScript(info, prefix, true), keys, args)) as T;
    } catch (error) {
      if (enableUpstashScriptFlags === undefined && isScriptFlagError(error)) {
        flagsRejected.add(client);
        warnFlagsRejected();
        return (await client.eval(info.script, keys, args)) as T;
      }
      throw error;
    }
  };
};
