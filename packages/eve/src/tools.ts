import type { ToolCache } from "@upstash/agentkit-sdk";
import type { EveExecute } from "./types.js";

export interface CachedExecuteConfig {
  /** The {@link ToolCache} memoizing results. */
  toolCache: ToolCache;
  /** Per-result TTL (seconds). */
  ttlSeconds?: number;
}

/**
 * Wrap an Eve tool's `execute` so identical inputs are memoized in a {@link ToolCache}. Eve tools are
 * defined per file with `defineTool`, where the filename is the tool name — so the cache `name` is
 * passed explicitly here (use the tool's filename, or any stable key).
 *
 * ```ts
 * // agent/tools/get_weather.ts
 * import { defineTool } from "eve/tools";
 * import { z } from "zod";
 * import { cachedExecute } from "@upstash/agentkit-eve";
 * import { ToolCache } from "@upstash/agentkit-sdk";
 * import { redis } from "../redis";
 *
 * export default defineTool({
 *   description: "Get the current weather for a city.",
 *   inputSchema: z.object({ city: z.string() }),
 *   execute: cachedExecute("get_weather", async ({ city }) => fetchWeather(city), {
 *     toolCache: new ToolCache({ redis }),
 *   }),
 * });
 * ```
 */
export function cachedExecute<A, R>(
  name: string,
  execute: EveExecute<A, R>,
  config: CachedExecuteConfig,
): EveExecute<A, R> {
  const { toolCache, ttlSeconds } = config;
  return (input: A, ctx) => {
    const run = toolCache.wrap<A, R>(
      name,
      (a) => Promise.resolve(execute(a, ctx)),
      ttlSeconds !== undefined ? { ttlSeconds } : {},
    );
    return run(input);
  };
}
