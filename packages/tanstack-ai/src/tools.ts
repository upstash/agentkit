import type { Sandbox, ToolCache } from "@upstash/agentkit-sdk";
import type { TanStackTool } from "./types.js";

export interface WrapToolsOptions {
  /** Memoize deterministic tool results via AgentKit's {@link ToolCache}. */
  toolCache?: ToolCache;
  /** Run each tool through AgentKit's {@link Sandbox} (timeout, retries, telemetry). */
  sandbox?: Sandbox;
  /** Per-result TTL (seconds) applied when caching. */
  ttlSeconds?: number;
}

/**
 * Wrap a single TanStack-AI-style tool so its execution is hardened with AgentKit primitives:
 *
 * - With a {@link Sandbox}, the tool is registered and run through it, gaining timeout/retry handling
 *   (and the sandbox's own caching/telemetry if configured).
 * - With a {@link ToolCache} (and no sandbox), the `execute` function is memoized directly, so two
 *   identical calls only run the underlying tool once.
 *
 * The returned tool preserves the original `name`, `description`, and `parameters`.
 */
export function wrapTool<TInput, TOutput>(
  tool: TanStackTool<TInput, TOutput>,
  options: WrapToolsOptions = {},
): TanStackTool<TInput, TOutput> {
  const { toolCache, sandbox, ttlSeconds } = options;

  let execute: (input: TInput) => Promise<TOutput>;

  if (sandbox) {
    // The sandbox owns timeout/retry/caching; register the raw tool and delegate to it.
    sandbox.register<TInput, TOutput>({
      name: tool.name,
      description: tool.description,
      execute: async (input) => (await tool.execute(input)) as TOutput,
    });
    execute = (input: TInput) => sandbox.execute<TOutput>(tool.name, input);
  } else if (toolCache) {
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
