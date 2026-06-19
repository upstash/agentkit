import type { ToolCache } from "@upstash/agentkit-sdk";
import type { EveTool, EveToolContext } from "./types.js";

export interface CacheToolsConfig {
  /** Memoize deterministic tool results so identical calls run the tool once. */
  toolCache?: ToolCache;
  /** Per-result TTL (seconds) applied when caching. */
  ttlSeconds?: number;
}

/**
 * Wrap a list of {@link EveTool}s so deterministic results are memoized in a {@link ToolCache} —
 * identical arguments run the underlying tool at most once. The returned tools keep the same
 * `name`/`description`/`parameters`, so they are a drop-in replacement in an {@link EveAgentConfig}.
 *
 * Note: heavyweight code-execution sandboxing lives separately — see this package's `/sandbox`
 * entry (`upstash()`), modeled on Eve's own sandbox (`eve/sandbox`).
 *
 * ```ts
 * const tools = cacheTools(agent.tools, { toolCache });
 * ```
 */
export function cacheTools(tools: EveTool[], config: CacheToolsConfig = {}): EveTool[] {
  const { toolCache, ttlSeconds } = config;

  return tools.map((tool) => {
    const run: (args: unknown) => Promise<unknown> = toolCache
      ? toolCache.wrap(
          tool.name,
          (args: unknown) => Promise.resolve(tool.execute(args as never)),
          ttlSeconds !== undefined ? { ttlSeconds } : {},
        )
      : (args: unknown) => Promise.resolve(tool.execute(args as never));

    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      execute: async (args: unknown, _ctx?: EveToolContext) => run(args),
    };
  });
}
