import type { ToolSet } from "ai";
import type { ToolCache } from "@upstash/agentkit-sdk";

export interface CacheToolsConfig {
  /** The {@link ToolCache} memoizing tool results. */
  toolCache: ToolCache;
  /** Per-result TTL (seconds). */
  ttlSeconds?: number;
}

/**
 * Memoize a map of AI SDK tools. Returns a new map with the **same keys**, where each tool's
 * `execute` is wrapped so identical arguments run the underlying tool at most once (cached in Redis,
 * keyed by the tool's map key + a stable hash of its arguments). Tools without an `execute`
 * (client-/provider-executed) are passed through unchanged.
 *
 * ```ts
 * const tools = cacheTools({ getWeather, search }, { toolCache: new ToolCache({ redis }) });
 * await generateText({ model, tools, prompt });
 * ```
 */
export function cacheTools<T extends ToolSet>(tools: T, config: CacheToolsConfig): T {
  const { toolCache, ttlSeconds } = config;
  const out: ToolSet = {};

  for (const [name, t] of Object.entries(tools)) {
    const original = t.execute;
    if (typeof original !== "function") {
      out[name] = t;
      continue;
    }
    out[name] = {
      ...t,
      execute: (args: unknown, options: unknown) => {
        const run = toolCache.wrap(
          name,
          (a: unknown) =>
            Promise.resolve((original as (i: unknown, o: unknown) => unknown)(a, options)),
          ttlSeconds !== undefined ? { ttlSeconds } : {},
        );
        return run(args);
      },
    } as T[string];
  }

  return out as T;
}
