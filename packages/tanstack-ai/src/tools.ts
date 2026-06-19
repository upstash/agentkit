import type { ToolCache } from "@upstash/agentkit-sdk";
import type { TanStackTool } from "./types.js";

export interface WrapToolsOptions {
  /** Memoize deterministic tool results via AgentKit's {@link ToolCache}. */
  toolCache?: ToolCache;
  /** Per-result TTL (seconds) applied when caching. */
  ttlSeconds?: number;
}

/**
 * Wrap a single TanStack-AI-style tool so its execution is hardened with AgentKit primitives:
 *
 * - With a {@link ToolCache}, the `execute` function is memoized directly, so two identical calls
 *   only run the underlying tool once.
 * - Without one, the tool's `execute` is passed through unchanged.
 *
 * The returned tool preserves the original `name`, `description`, and `parameters`.
 */
export function wrapTool<TInput, TOutput>(
  tool: TanStackTool<TInput, TOutput>,
  options: WrapToolsOptions = {},
): TanStackTool<TInput, TOutput> {
  const { toolCache, ttlSeconds } = options;

  let execute: (input: TInput) => Promise<TOutput>;

  if (toolCache) {
    execute = toolCache.wrap<TInput, TOutput>(
      tool.name,
      async (input) => (await tool.execute(input)) as TOutput,
      ttlSeconds !== undefined ? { ttlSeconds } : {},
    );
  } else {
    execute = async (input: TInput) => (await tool.execute(input)) as TOutput;
  }

  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute,
  };
}

/**
 * Wrap a collection of TanStack-AI-style tools (object map or array) with {@link wrapTool}. The
 * return shape matches the input: an array in → array out, a map in → map out.
 */
export function wrapTools<T extends TanStackTool>(
  tools: T[],
  options?: WrapToolsOptions,
): TanStackTool[];
export function wrapTools<T extends Record<string, TanStackTool>>(
  tools: T,
  options?: WrapToolsOptions,
): Record<string, TanStackTool>;
export function wrapTools(
  tools: TanStackTool[] | Record<string, TanStackTool>,
  options: WrapToolsOptions = {},
): TanStackTool[] | Record<string, TanStackTool> {
  if (Array.isArray(tools)) {
    return tools.map((t) => wrapTool(t, options));
  }
  const out: Record<string, TanStackTool> = {};
  for (const [key, tool] of Object.entries(tools)) {
    out[key] = wrapTool(tool, options);
  }
  return out;
}
