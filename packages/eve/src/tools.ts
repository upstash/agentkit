import type { Telemetry, ToolCache } from "@upstash/agentkit-sdk";
import type { EveTool, EveToolContext } from "./types.js";

export interface CacheToolsConfig {
  /** Memoize deterministic tool results so identical calls run the tool once. */
  toolCache?: ToolCache;
  /** Record a `tool` span per execution. */
  telemetry?: Telemetry;
  /** Trace id to attach tool spans to. */
  traceId?: string;
  /** Per-result TTL (seconds) applied when caching. */
  ttlSeconds?: number;
}

/**
 * Wrap a list of {@link EveTool}s with AgentKit's lightweight tool primitives: memoization via a
 * {@link ToolCache} (so identical arguments run the tool at most once) and an optional {@link Telemetry}
 * span per execution. The returned tools keep the same `name`/`description`/`parameters`, so they are
 * a drop-in replacement in an {@link EveAgentConfig}.
 *
 * Note: heavyweight code-execution sandboxing lives separately — see this package's `defineSandbox`
 * helpers, modeled on Eve's own sandbox (`eve/sandbox`).
 *
 * ```ts
 * const tools = cacheTools(agent.tools, { toolCache, telemetry });
 * ```
 */
export function cacheTools(tools: EveTool[], config: CacheToolsConfig = {}): EveTool[] {
  const { toolCache, telemetry, traceId, ttlSeconds } = config;

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
      execute: async (args: unknown, _ctx?: EveToolContext) => {
        if (!telemetry) return run(args);
        return telemetry.trace(tool.name, () => run(args), {
          type: "tool",
          ...(traceId !== undefined ? { traceId } : {}),
          attributes: { tool: tool.name },
        });
      },
    };
  });
}
