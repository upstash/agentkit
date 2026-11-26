import { createScriptRunner } from "@upstash/agentkit-sdk";
import type { ScriptRunner } from "@upstash/agentkit-sdk";

export { lua } from "@upstash/agentkit-sdk";
export type { LuaScript, ScriptRunner } from "@upstash/agentkit-sdk";

/** Scripts of this package are named `agentkit-tanstack-ai-js-<name>` in Upstash's script metrics. */
export const SCRIPT_NAME_PREFIX = "agentkit-tanstack-ai-js";

/** The `enableUpstashScriptFlags` option shared by every store that runs lua scripts. */
export interface ScriptFlagsConfig {
  /**
   * Whether to send the lua scripts with flags which only Upstash Redis understands: `script_name`,
   * which names each script (for example `agentkit-tanstack-ai-js-lock_acquire`) in Upstash's script
   * metrics, and `flags=allow-key-locking`, which lets scripts for different keys run in parallel.
   *
   * - unset (default): send the flags. If the server rejects them, the scripts are sent again without
   *   them, a warning is printed once and the flags are left off for that Redis client from then on.
   * - `false`: never send the flags. Use this with Redis servers other than Upstash Redis.
   * - `true`: always send the flags and throw if the server rejects them.
   */
  enableUpstashScriptFlags?: boolean;
}

/** Returns a function which runs this package's scripts on `redis` (see {@link ScriptFlagsConfig}). */
export const scriptRunner = (redis: unknown, enableUpstashScriptFlags?: boolean): ScriptRunner =>
  createScriptRunner(redis, { prefix: SCRIPT_NAME_PREFIX, enableUpstashScriptFlags });
