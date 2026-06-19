import type { ToolCache } from "@upstash/agentkit-sdk";
import type { AiTool, ToolExecuteOptions } from "./types.js";

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
export function cacheTools<T extends Record<string, AiTool>>(
  tools: T,
  config: CacheToolsConfig,
): T {
  const { toolCache, ttlSeconds } = config;
  const out: Record<string, AiTool> = {};

  for (const [name, tool] of Object.entries(tools)) {
    const original = tool.execute;
    if (!original) {
      out[name] = tool;
      continue;
    }
    out[name] = {
      ...tool,
      execute: (args: unknown, options: ToolExecuteOptions) => {
        const run = toolCache.wrap(
          name,
          (a: unknown) => Promise.resolve(original(a, options)),
          ttlSeconds !== undefined ? { ttlSeconds } : {},
        );
        return run(args);
      },
    };
  }

  return out as T;
}
