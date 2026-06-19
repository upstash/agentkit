import { Sandbox } from "@upstash/agentkit-sdk";
import type { SandboxConfig, ToolCache } from "@upstash/agentkit-sdk";
import type { EveTool, EveToolContext } from "./types.js";

export interface SandboxToolsConfig {
  /**
   * A pre-configured {@link Sandbox} (timeout/retry/telemetry/cache). When omitted, a fresh one is
   * created from {@link SandboxToolsConfig.sandboxConfig} (or defaults).
   */
  sandbox?: Sandbox;
  /** Options used to build a {@link Sandbox} when one is not supplied. */
  sandboxConfig?: SandboxConfig;
  /**
   * A {@link ToolCache} to memoize deterministic tool results. Wired into the sandbox so identical
   * calls hit the cache. Ignored when a pre-built `sandbox` already carries its own cache.
   */
  toolCache?: ToolCache;
}

/**
 * Wrap a list of {@link EveTool}s so each tool's `execute` runs through an AgentKit {@link Sandbox}:
 * bounded by a timeout (propagated via the Eve `ctx.signal` / `AbortSignal`), retried with backoff on
 * failure, and optionally served from a {@link ToolCache}. A failing tool surfaces a structured error
 * (the sandbox's captured `Error`) rather than hanging the run.
 *
 * The returned tools keep the same `name`/`description`/`parameters`, so they are a drop-in
 * replacement in an {@link EveAgentConfig}.
 *
 * ```ts
 * const safeTools = sandboxTools(tools, {
 *   sandboxConfig: { timeoutMs: 10_000, maxRetries: 2 },
 *   toolCache,
 * });
 * ```
 */
export function sandboxTools(tools: EveTool[], config: SandboxToolsConfig = {}): EveTool[] {
  const sandbox =
    config.sandbox ??
    new Sandbox({
      ...config.sandboxConfig,
      // Only inject the cache when the caller did not pass a fully-built sandbox.
      toolCache: config.sandboxConfig?.toolCache ?? config.toolCache,
    });

  // Register each tool once. The sandbox keys tools by name.
  for (const tool of tools) {
    if (!sandbox.has(tool.name)) {
      sandbox.register({
        name: tool.name,
        description: tool.description,
        execute: async (args, ctx) => tool.execute(args as never, { signal: ctx.signal }),
      });
    }
  }

  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: async (args: unknown, ctx?: EveToolContext) => {
      // `execute` throws on failure (after exhausting retries), surfacing the structured sandbox error.
      const signal = ctx?.signal;
      return sandbox.execute(tool.name, args, signal !== undefined ? { signal } : {});
    },
  }));
}
