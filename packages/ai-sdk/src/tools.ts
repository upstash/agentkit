import type { ToolCache } from "@upstash/agentkit-sdk";
import type { AiTool, ToolExecuteOptions } from "./types.js";

export interface WrapToolConfig {
  /**
   * Memoize deterministic results in this {@link ToolCache}, keyed by the tool name plus a stable
   * hash of its arguments. When omitted the tool runs directly.
   */
  toolCache?: ToolCache;
}

/**
 * Wrap an AI-SDK-style tool so its `execute` runs through AgentKit's {@link ToolCache}. The returned
 * object keeps the AI SDK tool shape (`description`, `parameters`/`inputSchema`, `execute`) so it can
 * be handed straight to `generateText({ tools: { name: wrapped } })`.
 *
 * - With a {@link ToolCache}: identical arguments are served from cache, so the underlying `execute`
 *   runs at most once per distinct argument set.
 * - Without one: the original `execute` is called directly.
 *
 * The original tool must define `execute` (provider-/client-executed tools have nothing to wrap).
 */
export function wrapTool<A = unknown, R = unknown>(
  name: string,
  aiTool: AiTool<A, R>,
  config: WrapToolConfig = {},
): AiTool<A, R> {
  const original = aiTool.execute;
  if (!original) {
    throw new Error(`wrapTool: tool "${name}" has no \`execute\` to wrap.`);
  }
  const { toolCache } = config;

  const wrapped: AiTool<A, R> = {
    ...aiTool,
    execute: async (args: A, options: ToolExecuteOptions): Promise<R> => {
      if (toolCache) {
        const exec = toolCache.wrap<A, R>(
          name,
          (a) => Promise.resolve(original(a, options)) as Promise<R>,
        );
        return exec(args);
      }

      return original(args, options) as Promise<R>;
    },
  };
  return wrapped;
}
